// Harness de avaliação OFFLINE da adjudicação (F4). Uso:
//   npm run eval:adjudication
//   npm run eval:adjudication -- --file tests/fixtures/eval/adjudication-basic.jsonl
//   npm run eval:adjudication -- --mode on --json
//
// Cada linha do dataset é um caso:
//   { "id": "...", "pack": {...}, "expect": {
//       "decisions": { "c1": { "titleId": "t1", "priceId": "p1", ... } },
//       "rejected": { "c2": "not_a_product" } } }
//
// Compara APENAS os IDs escolhidos (a IA nunca gera valores). Não abre rede com
// o provider `fake` (default). Saída: acurácia por campo, casos, latência p95.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import AdjudicationService from '../src/modules/adjudication/adjudicationService.ts'
import { disposeProviders } from '../src/providers/llm/index.ts'
import type { AdjudicationPack, AdjudicationResult } from '../src/types/adjudication.ts'

interface ExpectDecision {
  titleId?: string | null
  priceId?: string | null
  originalPriceId?: string | null
  imageId?: string | null
}

interface EvalCase {
  id: string
  pack: AdjudicationPack
  expect: {
    decisions: Record<string, ExpectDecision>
    rejected: Record<string, string>
  }
}

interface CaseOutcome {
  id: string
  ok: boolean
  latencyMs: number
  mode: string
  failures: string[]
}

const DECISION_FIELDS = ['titleId', 'priceId', 'originalPriceId', 'imageId'] as const

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : fallback
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function readCases(file: string): EvalCase[] {
  const text = readFileSync(file, 'utf8')
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line, index) => {
      try {
        return JSON.parse(line) as EvalCase
      } catch (error) {
        throw new Error(`linha ${index + 1} inválida: ${error instanceof Error ? error.message : 'JSON inválido'}`)
      }
    })
}

function decisionMap(result: AdjudicationResult): Map<string, AdjudicationResult['decisions'][number]> {
  return new Map(result.decisions.map((decision) => [decision.cardId, decision]))
}

function rejectionMap(result: AdjudicationResult): Map<string, string> {
  return new Map(result.rejected.map((rejection) => [rejection.cardId, rejection.reason]))
}

function evaluate(testCase: EvalCase, result: AdjudicationResult, latencyMs: number): CaseOutcome {
  const decisions = decisionMap(result)
  const rejections = rejectionMap(result)
  const failures: string[] = []

  for (const [cardId, expected] of Object.entries(testCase.expect.decisions)) {
    const actual = decisions.get(cardId)
    if (!actual) {
      failures.push(`${cardId}: sem decisão`)
      continue
    }
    if (rejections.has(cardId)) failures.push(`${cardId}: decidido e rejeitado ao mesmo tempo`)
    for (const field of DECISION_FIELDS) {
      if (!(field in expected)) continue
      const want = expected[field] ?? null
      if ((actual[field] ?? null) !== want) failures.push(`${cardId}.${field}: esperado ${String(want)}, veio ${String(actual[field] ?? null)}`)
    }
  }

  for (const [cardId, reason] of Object.entries(testCase.expect.rejected)) {
    const actual = rejections.get(cardId)
    if (actual !== reason) failures.push(`${cardId}.rejected: esperado ${reason}, veio ${actual ?? 'decisão'}`)
  }

  return { id: testCase.id, ok: failures.length === 0, latencyMs, mode: result.mode, failures }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[index] ?? 0
}

async function main(): Promise<void> {
  const file = resolve(argValue('file', 'tests/fixtures/eval/adjudication-basic.jsonl'))
  const mode = argValue('mode', 'on')
  const json = hasFlag('json')
  process.env['AI_ADJ_MODE'] = mode

  const cases = readCases(file)
  const outcomes: CaseOutcome[] = []
  let invalid = 0

  for (const testCase of cases) {
    const started = Date.now()
    try {
      const result = await AdjudicationService.adjudicate(testCase.pack)
      const latencyMs = Date.now() - started
      outcomes.push(evaluate(testCase, result, latencyMs))
    } catch (error) {
      invalid += 1
      outcomes.push({
        id: testCase.id,
        ok: false,
        latencyMs: Date.now() - started,
        mode: 'invalid',
        failures: [error instanceof Error ? error.message : 'erro desconhecido'],
      })
    }
  }

  const passed = outcomes.filter((outcome) => outcome.ok).length
  const failed = outcomes.length - passed
  const latencies = outcomes.map((outcome) => outcome.latencyMs)
  const summary = {
    file,
    mode,
    provider: process.env['LLM_PROVIDER'] ?? 'fake',
    cases: outcomes.length,
    passed,
    failed,
    invalid,
    avgLatencyMs: latencies.length > 0 ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0,
    p95LatencyMs: percentile(latencies, 95),
    outcomes,
  }

  if (json) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    for (const outcome of outcomes) {
      console.log(
        `${outcome.ok ? 'ok  ' : 'FAIL'} ${outcome.id} (${outcome.mode}, ${outcome.latencyMs}ms)` +
          (outcome.failures.length > 0 ? `\n     - ${outcome.failures.join('\n     - ')}` : ''),
      )
    }
    console.log(
      `\ncasos=${summary.cases} ok=${passed} falhas=${failed} invalidos=${invalid} ` +
        `latencia_media=${summary.avgLatencyMs}ms p95=${summary.p95LatencyMs}ms`,
    )
  }

  await disposeProviders()
  if ((failed > 0 || invalid > 0) && !hasFlag('allow-fail')) process.exitCode = 1
}

main().catch(async (error) => {
  console.error('ERRO:', error instanceof Error ? error.message : error)
  await disposeProviders().catch(() => undefined)
  process.exitCode = 1
})
