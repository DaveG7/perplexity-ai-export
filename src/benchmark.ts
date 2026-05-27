import { performance } from 'node:perf_hooks'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './utils/config.js'
import { errorBus } from './utils/error-bus.js'
import { logger } from './utils/logger.js'
import { VectorStore } from './search/vector-store.js'
import { RagOrchestrator } from './ai/rag-orchestrator.js'

// Add your own questions here — the more specific, the more useful the benchmark
const BENCHMARK_QUERIES = [
  'What TypeScript patterns have I used in past projects?',
  'Which npm packages have I discussed installing?',
  'What errors or bugs did I troubleshoot recently?',
  'What AI models or tools have I researched?',
  'What architecture decisions did I make?',
]

async function runBenchmark(): Promise<void> {
  const indexPath = join(config.vectorIndexPath, 'index.json')
  if (!existsSync(indexPath)) {
    logger.error('No vector index found. Build the index first via the main menu.')
    process.exit(1)
  }

  logger.info(`Starting benchmark with ${BENCHMARK_QUERIES.length} queries...`)

  const vectorStore = new VectorStore(config)
  await vectorStore.validate()

  const orchestrator = new RagOrchestrator(config)
  const results: { query: string; ms: number; error: boolean }[] = []

  for (let i = 0; i < BENCHMARK_QUERIES.length; i++) {
    const query = BENCHMARK_QUERIES[i]!
    logger.info(`[${i + 1}/${BENCHMARK_QUERIES.length}] "${query}"`)

    const start = performance.now()
    let failed = false

    try {
      await orchestrator.answerQuestion(query)
    } catch (err) {
      failed = true
      errorBus.emitError('Benchmark query failed', err, { query })
    }

    const ms = Math.round(performance.now() - start)
    results.push({ query, ms, error: failed })

    if (failed) {
      logger.warn(`Query failed after ${ms}ms`)
    } else {
      logger.success(`Done in ${ms}ms`)
    }
  }

  const successful = results.filter((r) => !r.error)
  const failed = results.filter((r) => r.error)
  const avgMs =
    successful.length > 0
      ? Math.round(successful.reduce((acc, r) => acc + r.ms, 0) / successful.length)
      : 0

  logger.info('--- Benchmark Results ---')
  results.forEach((r, i) => {
    const status = r.error ? '✗' : '✓'
    logger.info(`  ${status} [${i + 1}] ${r.ms}ms — ${r.query}`)
  })
  logger.info(`Successful: ${successful.length}/${results.length}`)
  logger.info(`Average latency: ${avgMs}ms`)

  if (failed.length > 0) {
    logger.warn(`${failed.length} queries failed — run with DEBUG=true for details`)
  }
}

runBenchmark().catch((err) => {
  errorBus.emitError('Benchmark failed', err)
  process.exit(1)
})
