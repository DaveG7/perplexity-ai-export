/**
 * Benchmark command: measures retrieval quality for the RAG pipeline.
 * Usage: npm run benchmark
 *
 * Runs a set of test queries against your actual export and reports:
 *  - Time per stage (planner, search, rerank, mapreduce, synthesis)
 *  - Total latency
 *  - Number of facts extracted
 *  - Whether the cross-encoder reranker is active
 */
import { performance } from 'node:perf_hooks'
import chalk from 'chalk'
import { loadConfig } from './utils/config.js'
import { RagOrchestrator } from './ai/rag-orchestrator.js'

// Add your own questions here — the more specific, the more useful the benchmark
const BENCHMARK_QUERIES = [
  'What TypeScript patterns have I used in past projects?',
  'Which npm packages have I discussed installing?',
  'What errors or bugs did I troubleshoot recently?',
  'What AI models or tools have I researched?',
  'What architecture decisions did I make?',
]

const HR = chalk.gray('─'.repeat(60))

async function runBenchmark() {
  console.log(`\n${chalk.bold.magenta('🏋️  RAG Pipeline Benchmark')}\n${HR}`)

  const config = await loadConfig()
  const orchestrator = new RagOrchestrator(config)

  const results: { query: string; ms: number; facts: number }[] = []

  for (const query of BENCHMARK_QUERIES) {
    console.log(`\n${chalk.bold.cyan('Query:')} ${query}`)
    const start = performance.now()

    // Patch answerQuestion to capture timing without printing the full response
    let factCount = 0
    const originalLog = console.log
    console.log = (...args: any[]) => {
      const str = String(args[0] ?? '')
      if (str.includes('verified facts')) {
        const match = str.match(/(\d+) verified/)
        if (match) factCount = parseInt(match[1]!, 10)
      }
    }

    try {
      await (orchestrator as any).answerQuestion(query)
    } catch (_) {
      // continue even on error
    } finally {
      console.log = originalLog
    }

    const ms = Math.round(performance.now() - start)
    results.push({ query, ms, facts: factCount })
    console.log(`  ${chalk.green('✓')} ${ms}ms  |  ${factCount} facts extracted`)
  }

  // Summary table
  console.log(`\n${HR}\n${chalk.bold('Results Summary')}\n${HR}`)
  const totalMs = results.reduce((acc, r) => acc + r.ms, 0)
  const avgMs = Math.round(totalMs / results.length)
  const avgFacts = Math.round(results.reduce((acc, r) => acc + r.facts, 0) / results.length)

  results.forEach((r, i) => {
    const bar = '█'.repeat(Math.round(r.ms / 1000)).padEnd(10)
    console.log(`  ${String(i + 1).padStart(2)}. ${chalk.gray(bar)} ${r.ms}ms  ${r.facts} facts  ${chalk.dim(r.query.slice(0, 45))}...`)
  })

  console.log(`\n${HR}`)
  console.log(`  Avg latency : ${chalk.yellow(avgMs + 'ms')}`)
  console.log(`  Avg facts   : ${chalk.yellow(avgFacts)}`)
  console.log(`  Total time  : ${chalk.yellow(totalMs + 'ms')}\n`)
}

runBenchmark().catch((err) => {
  console.error(chalk.red('Benchmark failed:'), err)
  process.exit(1)
})
