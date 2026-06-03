import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConversationExtractor } from '../../src/scraper/conversation-extractor.js'
import type { BrowserContext, Page } from '@playwright/test'

describe('ConversationExtractor (Unit)', () => {
  let extractor: ConversationExtractor
  let mockContext: BrowserContext
  const mockConfig = {
    waitMode: 'static',
    rateLimitMs: 1000,
    debug: true,
  } as any

  beforeEach(() => {
    mockContext = {
      newPage: vi.fn(),
      pages: vi.fn(),
    } as unknown as BrowserContext
    extractor = new ConversationExtractor(mockConfig, mockContext)
    vi.clearAllMocks()
  })

  // ─── ensureEntriesFormat ──────────────────────────────────────────────────────

  describe('ensureEntriesFormat', () => {
    it('returns array as-is when input is already an array', () => {
      const data = [{ query_str: 'test' }]
      const result = (extractor as any).ensureEntriesFormat(data, 'http://test.com')
      expect(result).toEqual(data)
    })

    it('returns data.entries when input has an entries array', () => {
      const data = { entries: [{ query_str: 'test' }] }
      const result = (extractor as any).ensureEntriesFormat(data, 'http://test.com')
      expect(result).toEqual(data.entries)
    })

    it('wraps single entry object when it has query_str', () => {
      const data = { query_str: 'test' }
      const result = (extractor as any).ensureEntriesFormat(data, 'http://test.com')
      expect(result).toEqual([data])
    })

    it('wraps single entry object when it has blocks', () => {
      const data = { blocks: [] }
      const result = (extractor as any).ensureEntriesFormat(data, 'http://test.com')
      expect(result).toEqual([data])
    })

    it('returns empty array for unknown shape', () => {
      const result = (extractor as any).ensureEntriesFormat({ foo: 'bar' }, 'http://test.com')
      expect(result).toEqual([])
    })
  })

  // ─── parseConversationData ────────────────────────────────────────────────────

  describe('parseConversationData', () => {
    it('returns null when entries array is empty', () => {
      const result = (extractor as any).parseConversationData(
        { entries: [] },
        'https://www.perplexity.ai/search/test-id'
      )
      expect(result).toBeNull()
    })

    it('parses new-format entries (blocks with markdown_block.answer)', () => {
      const data = {
        entries: [
          {
            thread_title: 'Test Thread',
            query_str: 'What is 1+1?',
            updated_datetime: '2026-01-01T00:00:00Z',
            blocks: [
              { intended_usage: 'plan', plan_block: {} },
              {
                intended_usage: 'ask_text_0_markdown',
                markdown_block: { answer: 'The answer is 2.' },
              },
            ],
          },
        ],
      }
      const result = (extractor as any).parseConversationData(
        data,
        'https://www.perplexity.ai/search/test-id'
      )
      expect(result).not.toBeNull()
      expect(result.title).toBe('Test Thread')
      expect(result.content).toContain('What is 1+1?')
      expect(result.content).toContain('The answer is 2.')
    })

    it('deduplicates identical answers from ask_text and ask_text_0_markdown blocks', () => {
      const answer = 'The answer is 2.'
      const data = {
        entries: [
          {
            thread_title: 'Dedupe Test',
            query_str: 'What is 1+1?',
            blocks: [
              { intended_usage: 'ask_text_0_markdown', markdown_block: { answer } },
              { intended_usage: 'ask_text', markdown_block: { answer } },
            ],
          },
        ],
      }
      const result = (extractor as any).parseConversationData(
        data,
        'https://www.perplexity.ai/search/test-id'
      )
      expect(result).not.toBeNull()
      const occurrences = (result.content.match(/The answer is 2\./g) ?? []).length
      expect(occurrences).toBe(1)
    })

    it('extracts space name from collection_info', () => {
      const data = {
        entries: [
          {
            thread_title: 'Test',
            query_str: 'Question',
            collection_info: { title: 'HomeLab' },
            blocks: [
              { intended_usage: 'ask_text_0_markdown', markdown_block: { answer: 'Answer' } },
            ],
          },
        ],
      }
      const result = (extractor as any).parseConversationData(
        data,
        'https://www.perplexity.ai/search/test-id'
      )
      expect(result?.spaceName).toBe('HomeLab')
    })

    it('handles multi-turn conversations', () => {
      const data = {
        entries: [
          {
            thread_title: 'Multi-turn',
            query_str: 'First question',
            blocks: [
              { intended_usage: 'ask_text_0_markdown', markdown_block: { answer: 'First answer' } },
            ],
          },
          {
            query_str: 'Follow-up question',
            blocks: [
              {
                intended_usage: 'ask_text_0_markdown',
                markdown_block: { answer: 'Follow-up answer' },
              },
            ],
          },
        ],
      }
      const result = (extractor as any).parseConversationData(
        data,
        'https://www.perplexity.ai/search/test-id'
      )
      expect(result?.messages).toHaveLength(4)
      expect(result?.messages[0]).toEqual({ role: 'user', content: 'First question' })
      expect(result?.messages[1]).toEqual({ role: 'assistant', content: 'First answer' })
      expect(result?.messages[2]).toEqual({ role: 'user', content: 'Follow-up question' })
      expect(result?.messages[3]).toEqual({ role: 'assistant', content: 'Follow-up answer' })
    })
  })

  // ─── fetchThreadData ──────────────────────────────────────────────────────────

  describe('fetchThreadData', () => {
    const makePage = (status: number, body: string): Page =>
      ({ evaluate: vi.fn().mockResolvedValue({ status, body }) }) as unknown as Page

    it('returns parsed JSON on HTTP 200', async () => {
      const payload = {
        entries: [{ thread_title: 'Test', query_str: 'q', blocks: [] }],
        background_entries: [],
      }
      const page = makePage(200, JSON.stringify(payload))
      const result = await (extractor as any).fetchThreadData(page, 'abc-123')
      expect(result).toEqual(payload)
    })

    it('throws AuthError on HTTP 401', async () => {
      const page = makePage(401, '{}')
      await expect((extractor as any).fetchThreadData(page, 'abc-123')).rejects.toThrow(
        ConversationExtractor.AuthError
      )
    })

    it('throws AuthError on HTTP 403', async () => {
      const page = makePage(403, '{}')
      await expect((extractor as any).fetchThreadData(page, 'abc-123')).rejects.toThrow(
        ConversationExtractor.AuthError
      )
    })

    it('throws NotFoundError on HTTP 404', async () => {
      const page = makePage(404, '{}')
      await expect((extractor as any).fetchThreadData(page, 'abc-123')).rejects.toThrow(
        ConversationExtractor.NotFoundError
      )
    })

    it('throws ServerError on HTTP 500', async () => {
      const page = makePage(500, '{}')
      await expect((extractor as any).fetchThreadData(page, 'abc-123')).rejects.toThrow(
        ConversationExtractor.ServerError
      )
    })

    it('throws ExtractionError on invalid JSON body', async () => {
      const page = makePage(200, 'not-json')
      await expect((extractor as any).fetchThreadData(page, 'abc-123')).rejects.toThrow(
        ConversationExtractor.ExtractionError
      )
    })

    it('calls the correct API URL with thread ID', async () => {
      const page = makePage(200, '{"entries":[],"background_entries":[]}')
      await (extractor as any).fetchThreadData(page, 'my-thread-id').catch(() => {})
      const callArg = (page.evaluate as any).mock.calls[0][1]
      expect(callArg.url).toContain('/rest/thread/my-thread-id')
    })
  })
})
