import { createHash } from 'node:crypto'
import { errorBus } from '../utils/error-bus.js'
import { z } from 'zod'
import { type Page, type BrowserContext, type Response } from '@playwright/test'
import { logger } from '../utils/logger.js'
import { waitStrategy } from '../utils/wait-strategy.js'
import { type Config } from '../utils/config.js'
import { ApiDiagnosticsWriter } from '../utils/api-diagnostics.js'
import { DEFAULT_API_VERSION } from './api-version.js'

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ExtractedConversation {
  id: string
  contentHash: string
  title: string
  spaceName: string
  timestamp: Date
  content: string
  messages: ConversationMessage[]
}

export class ConversationExtractor {
  private static readonly BlockSchema = z.object({
    intended_usage: z.string().optional(),
    markdown_block: z
      .object({
        answer: z.string().optional(),
      })
      .optional(),
  })

  private static readonly EntrySchema = z.object({
    thread_title: z.string().optional(),
    collection_info: z
      .object({
        title: z.string().optional(),
      })
      .optional(),
    updated_datetime: z.string().optional(),
    query_str: z.string().optional(),
    blocks: z.array(ConversationExtractor.BlockSchema).optional(),
  })

  /**
   * Validates the top-level shape of the `/rest/thread/{id}` HTTP response,
   * confirmed against a live 2026 response. The endpoint returns either a bare
   * array of entries or an object wrapping them; pagination is signalled by the
   * top-level `has_next_page` / `next_cursor` pair. Fields are optional and the
   * object is non-strict, so unknown/new keys don't reject an otherwise-valid
   * response — shape drift is surfaced via diagnostics, and `EntrySchema`
   * remains the per-entry fallback downstream.
   */
  private static readonly ApiResponseSchema = z.union([
    z.array(ConversationExtractor.EntrySchema),
    z.object({
      entries: z.array(ConversationExtractor.EntrySchema),
      background_entries: z.array(z.unknown()).optional(),
      has_next_page: z.boolean().optional(),
      next_cursor: z.string().nullable().optional(),
      status: z.string().optional(),
      thread_metadata: z.unknown().optional(),
      // Legacy/list-style pagination — kept for backward compatibility.
      collection_info: z
        .object({
          has_next_page: z.boolean().optional(),
        })
        .optional(),
    }),
  ])

  static readonly ExtractionError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'ExtractionError'
    }
  }

  static readonly NavigationError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'NavigationError'
    }
  }

  static readonly NotFoundError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'NotFoundError'
    }
  }

  static readonly AuthError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'AuthError'
    }
  }

  static readonly ServerError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'ServerError'
    }
  }

  static readonly NoDataError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'NoDataError'
    }
  }

  static readonly ParsingError = class extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'ParsingError'
    }
  }

  private readonly diagnostics: ApiDiagnosticsWriter

  constructor(
    private readonly config: Config,
    private readonly context: BrowserContext
  ) {
    this.diagnostics = new ApiDiagnosticsWriter(config)
  }

  async extract(conversationUrl: string): Promise<ExtractedConversation> {
    await this.ensureContextIsAlive()

    let conversationPage: Page | null = null
    try {
      conversationPage = await this.context.newPage()
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new ConversationExtractor.ExtractionError(`Failed to create new page: ${errorMessage}`)
    }

    try {
      await this.navigateToConversationUrl(conversationPage, conversationUrl)
      await waitStrategy(this.config).afterScroll(conversationPage)

      const conversationId = this.extractIdFromUrl(conversationUrl)
      const capturedApiData = await this.fetchThreadData(conversationPage, conversationId)

      const extractedConversation = this.parseConversationData(capturedApiData, conversationUrl)
      if (!extractedConversation) {
        throw new ConversationExtractor.ParsingError('Failed to parse conversation data')
      }

      return extractedConversation
    } catch (error) {
      if (error instanceof Error) throw error
      throw new ConversationExtractor.ExtractionError(String(error))
    } finally {
      if (conversationPage) {
        await conversationPage.close().catch((closeError) => {
          logger.warn(`Failed to close page: ${closeError}`)
        })
      }
    }
  }

  // Safety cap on cursor pagination (~99 entries/page, so ~5k entries).
  private static readonly MAX_PAGES = 50

  private async fetchThreadData(page: Page, threadId: string): Promise<unknown> {
    const firstParsed = await this.fetchThreadPage(page, threadId, null)
    const firstObj =
      firstParsed && !Array.isArray(firstParsed) ? (firstParsed as Record<string, unknown>) : null

    let cursor = typeof firstObj?.next_cursor === 'string' ? firstObj.next_cursor : null

    // Fast path: the whole thread fit in one response (the common case).
    if (firstObj?.has_next_page !== true || !cursor) {
      return firstParsed
    }

    // Long thread: walk the cursor pages and accumulate entries in API order
    // (the endpoint paginates in conversation order — the same order the previous
    // response-listener relied on, so no reordering is needed here).
    const entries: unknown[] = Array.isArray(firstObj.entries) ? [...firstObj.entries] : []
    const backgroundEntries: unknown[] = Array.isArray(firstObj.background_entries)
      ? [...firstObj.background_entries]
      : []
    let pageCount = 1

    while (cursor && pageCount < ConversationExtractor.MAX_PAGES) {
      const parsed = await this.fetchThreadPage(page, threadId, cursor)
      const obj = Array.isArray(parsed)
        ? { entries: parsed as unknown[] }
        : (parsed as Record<string, unknown>)

      if (Array.isArray(obj.entries)) entries.push(...obj.entries)
      if (Array.isArray(obj.background_entries)) backgroundEntries.push(...obj.background_entries)
      pageCount++

      cursor =
        obj.has_next_page === true && typeof obj.next_cursor === 'string' ? obj.next_cursor : null
    }

    if (cursor) {
      logger.warn(
        `[extractor] thread ${threadId}: stopped at the ${ConversationExtractor.MAX_PAGES}-page ` +
          'cap; export may be truncated'
      )
    }
    logger.debug(
      `[extractor] thread ${threadId}: assembled ${entries.length} entries from ${pageCount} pages`
    )

    // Preserve the first page's top-level metadata, but with the full entry set.
    return {
      ...firstObj,
      entries,
      background_entries: backgroundEntries,
      has_next_page: false,
      next_cursor: null,
    }
  }

  /** Fetches and validates a single page of the thread API (cursor = null for page 1). */
  private async fetchThreadPage(
    page: Page,
    threadId: string,
    cursor: string | null
  ): Promise<unknown> {
    let apiUrl = `https://www.perplexity.ai/rest/thread/${threadId}?version=${DEFAULT_API_VERSION}&source=default`
    if (cursor) apiUrl += `&cursor=${encodeURIComponent(cursor)}`

    const raw = await page.evaluate(
      async ({ url }: { url: string }) => {
        const res = await fetch(url, { credentials: 'include' })
        const text = await res.text()
        return { status: res.status, body: text }
      },
      { url: apiUrl }
    )

    logger.debug(`[extractor] thread ${threadId}: HTTP ${raw.status}${cursor ? ' (paged)' : ''}`)

    if (raw.status === 401 || raw.status === 403) {
      throw new ConversationExtractor.AuthError(`Authentication required (${raw.status})`)
    }
    if (raw.status === 404) {
      throw new ConversationExtractor.NotFoundError('Thread not found (404)')
    }
    if (raw.status >= 500) {
      throw new ConversationExtractor.ServerError(`Server error (${raw.status})`)
    }
    if (raw.status !== 200) {
      throw new ConversationExtractor.ExtractionError(`Thread API returned HTTP ${raw.status}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw.body)
    } catch {
      throw new ConversationExtractor.ExtractionError(`Thread API: invalid JSON for ${threadId}`)
    }

    // Validate the HTTP response shape. On drift we record a diagnostic and fall
    // through — the per-entry EntrySchema downstream is the resilient fallback,
    // so a shape change is surfaced without breaking extraction.
    const shapeResult = ConversationExtractor.ApiResponseSchema.safeParse(parsed)
    if (!shapeResult.success) {
      logger.warn(`[extractor] thread ${threadId}: unexpected response shape (see api-diagnostics)`)
      this.diagnostics
        .writeFailure({
          url: apiUrl,
          errorType: 'zod_error',
          zodErrorPaths: shapeResult.error.issues.map((issue) => issue.path.join('.')),
        })
        .catch(() => {})
    }

    return parsed
  }

  private async ensureContextIsAlive(): Promise<void> {
    if (!this.context) {
      throw new ConversationExtractor.ExtractionError('Browser context is missing')
    }
    try {
      await this.context.pages()
    } catch (_error) {
      throw new ConversationExtractor.ExtractionError('Browser context is no longer available')
    }
  }

  private async navigateToConversationUrl(page: Page, url: string): Promise<void> {
    const NAVIGATION_TIMEOUT_MS = 30000
    const navigationResponse = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    })
    this.validateNavigationResponse(navigationResponse)
  }

  private validateNavigationResponse(response: Response | null): void {
    if (!response) {
      throw new ConversationExtractor.NavigationError('Navigation failed – no response')
    }

    const httpStatusCode = response.status()
    if (httpStatusCode === 404) {
      throw new ConversationExtractor.NotFoundError('Conversation not found (404)')
    }
    if (httpStatusCode === 403 || httpStatusCode === 401) {
      throw new ConversationExtractor.AuthError('Authentication required or expired')
    }
    if (httpStatusCode >= 500) {
      throw new ConversationExtractor.ServerError(`Server error (${httpStatusCode})`)
    }
    if (httpStatusCode >= 400) {
      throw new ConversationExtractor.NavigationError(`HTTP error ${httpStatusCode}`)
    }
  }

  private hashEntries(rawEntries: unknown[]): string {
    const stableJsonString = JSON.stringify(rawEntries, (_key, value) => {
      const isObjectButNotArray = value && typeof value === 'object' && !Array.isArray(value)
      if (isObjectButNotArray) {
        return Object.keys(value)
          .sort()
          .reduce((sortedObj: Record<string, unknown>, currentKey) => {
            sortedObj[currentKey] = (value as Record<string, unknown>)[currentKey]
            return sortedObj
          }, {})
      }
      return value
    })
    return createHash('sha256').update(stableJsonString).digest('hex')
  }

  private parseConversationData(
    apiData: unknown,
    conversationUrl: string
  ): ExtractedConversation | null {
    try {
      const formattedEntries = this.ensureEntriesFormat(apiData, conversationUrl)

      const entriesValidationResult = z
        .array(ConversationExtractor.EntrySchema)
        .nonempty({ message: 'No valid entries found' })
        .safeParse(formattedEntries)

      if (!entriesValidationResult.success) {
        if (formattedEntries.length === 0) {
          this.diagnostics
            .writeFailure({ url: conversationUrl, errorType: 'empty_entries' })
            .catch(() => {})
        }
        logger.warn(
          `Entry validation failed for ${conversationUrl}: ${entriesValidationResult.error.message}`
        )
        return null
      }

      const validatedEntries = entriesValidationResult.data
      const firstEntry = validatedEntries[0]!
      const conversationId = this.extractIdFromUrl(conversationUrl)

      const threadTitleFromData = (apiData as any)?.thread_title
      const collectionTitleFromData = (apiData as any)?.collection_info?.title

      const title = firstEntry.thread_title ?? threadTitleFromData ?? 'Untitled'
      const spaceName = firstEntry.collection_info?.title ?? collectionTitleFromData ?? 'General'
      const timestamp = this.extractTimestamp(firstEntry, apiData)
      const contentHash = this.hashEntries(validatedEntries)
      const messages = this.parseMessages(validatedEntries, title)
      const markdownContent = this.convertMessagesToMarkdown(messages)

      if (!markdownContent && messages.length === 0) {
        logger.warn(`Thread has no content or messages: ${conversationUrl}`)
        return null
      }

      return {
        id: conversationId,
        title,
        spaceName,
        timestamp,
        content: markdownContent,
        contentHash,
        messages,
      }
    } catch (error) {
      errorBus.emitError('Failed to parse conversation data.', error)
      return null
    }
  }

  private ensureEntriesFormat(data: unknown, url: string): unknown[] {
    if (Array.isArray(data)) return data as unknown[]

    const dataObject = data as Record<string, unknown>
    if (dataObject && Array.isArray(dataObject.entries)) return dataObject.entries as unknown[]
    if (dataObject && (dataObject.query_str || dataObject.blocks)) return [data]

    logger.warn(`Unknown API response shape for ${url}`)
    this.diagnostics.writeFailure({ url, errorType: 'unknown_shape' }).catch(() => {})
    return []
  }

  private extractIdFromUrl(url: string): string {
    const match = url.match(/\/search\/([^/?]+)/)
    return match?.[1] ?? 'unknown'
  }

  private extractTimestamp(firstEntry: any, data: unknown): Date {
    const rawTimestamp = firstEntry.updated_datetime ?? (data as any)?.updated_datetime
    return rawTimestamp ? new Date(rawTimestamp) : new Date()
  }

  private parseMessages(entries: unknown[], threadTitle: string): ConversationMessage[] {
    const messages: ConversationMessage[] = []
    const typedEntries = entries as any[]

    for (let i = 0; i < typedEntries.length; i++) {
      const entry = typedEntries[i]
      const question = entry.query_str ?? (i === 0 ? threadTitle : 'Follow‑up')

      if (question) {
        messages.push({ role: 'user', content: question })
      }

      let answer = ''
      const seenAnswers = new Set<string>()
      for (const block of entry.blocks ?? []) {
        const blockAnswer = block.markdown_block?.answer
        if (blockAnswer && !seenAnswers.has(blockAnswer)) {
          seenAnswers.add(blockAnswer)
          answer += blockAnswer + '\n\n'
        }
      }

      if (answer.trim()) {
        messages.push({ role: 'assistant', content: answer.trim() })
      }
    }

    return messages
  }

  private convertMessagesToMarkdown(messages: ConversationMessage[]): string {
    let markdown = ''
    for (const message of messages) {
      if (message.role === 'user') {
        markdown += `## ${message.content}\n\n`
      } else {
        markdown += `${message.content}\n\n---\n\n`
      }
    }
    return markdown.trim()
  }
}
