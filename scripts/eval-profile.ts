import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stableStringify } from '../src/helpers/packHash.ts'

// ============================================================================
// Harness de avaliação OFFLINE do pipeline v2.
//
// Uso:
//   npm run eval:profile
//   npm run eval:profile -- --file tests/fixtures/eval/profile-basic.jsonl --json
//   npm run eval:profile -- --mode on --allow-fail
//
// Cada linha:
//   { "id": "...", "profile": "cards", "input": {...},
//     "fakeOutput": {...}, "expect": { "validationOk": true, "mode": "fake",
//     "output": {...} } }
//
// `fakeOutput` só é usado quando o modelo do perfil é `fake`; para providers
// reais, configure AI_MODELS_JSON no .env e omita `fakeOutput`.
// ============================================================================

interface EvalCase {
  id: string
  profile: string
  input: unknown
  fakeOutput?: unknown
  expect: {
    validationOk?: boolean
    mode?: string
    fallbackReason?: string | null
    output?: unknown
  }
}

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : fallback
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function ensureDefaultConfig(): void {
  // Cada caso pode reaproveitar o mesmo input com fakeOutput diferente; o cache
  // de aplicação mascararia o segundo caso.
  process.env['AI_APP_CACHE'] = 'off'

  const profiles = (process.env['AI_PROFILES_JSON'] ?? '').trim()
  const profilesB64 = (process.env['AI_PROFILES_B64'] ?? '').trim()
  if (profiles === '' && profilesB64 === '') {
    const cards = JSON.parse(readFileSync('profiles/cards.json', 'utf8')) as unknown
    process.env['AI_PROFILES_JSON'] = JSON.stringify([cards])
  }

  const models = (process.env['AI_MODELS_JSON'] ?? '').trim()
  const hasModels = models !== '' && models !== '[]'
  if (!hasModels) {
    process.env['AI_MODELS_JSON'] = JSON.stringify([
      {
        id: 'fast',
        version: 'fast@eval',
        provider: 'fake',
        model: 'fake',
        baseUrl: '',
        apiKeyEnv: '',
        structuredOutput: 'json_schema',
        promptCaching: 'off',
      },
    ])
  }
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

function isSubset(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false
    return expected.every((value, index) => isSubset(value, actual[index]))
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false
    const want = expected as Record<string, unknown>
    const got = actual as Record<string, unknown>
    return Object.keys(want).every((key) => isSubset(want[key], got[key]))
  }
  return false
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[index] ?? 0
}

async function main(): Promise<void> {
  ensureDefaultConfig()

  const { default: ExecutionService } = await import('../src/modules/execution/executionService.ts')
  const { disposeCatalogProviders } = await import('../src/providers/llm/catalogProvider.ts')

  const file = resolve(argValue('file', 'tests/fixtures/eval/profile-basic.jsonl'))
  const mode = argValue('mode', 'on') as 'off' | 'shadow' | 'assist' | 'on'
  const json = hasFlag('json')
  const cases = readCases(file)
  const outcomes: Array<{
    id: string
    ok: boolean
    latencyMs: number
    mode: string
    failures: string[]
  }> = []

  for (const testCase of cases) {
    const started = Date.now()
    try {
      if (testCase.fakeOutput !== undefined) {
        process.env['FAKE_EXECUTION_OUTPUT'] = stableStringify(testCase.fakeOutput)
      } else {
        delete process.env['FAKE_EXECUTION_OUTPUT']
      }

      const result = await ExecutionService.execute({
        profile: testCase.profile,
        input: testCase.input,
        options: { mode },
      })
      const failures: string[] = []
      if (testCase.expect.validationOk !== undefined && result.validation.ok !== testCase.expect.validationOk) {
        failures.push(`validationOk: esperado ${String(testCase.expect.validationOk)}, veio ${String(result.validation.ok)}`)
      }
      if (testCase.expect.mode !== undefined && result.mode !== testCase.expect.mode) {
        failures.push(`mode: esperado ${testCase.expect.mode}, veio ${result.mode}`)
      }
      if (
        testCase.expect.fallbackReason !== undefined &&
        result.fallbackReason !== testCase.expect.fallbackReason
      ) {
        failures.push(
          `fallbackReason: esperado ${String(testCase.expect.fallbackReason)}, veio ${String(result.fallbackReason)}`,
        )
      }
      if (testCase.expect.output !== undefined && !isSubset(testCase.expect.output, result.output)) {
        failures.push('output: não contém o subconjunto esperado')
      }

      outcomes.push({
        id: testCase.id,
        ok: failures.length === 0,
        latencyMs: Date.now() - started,
        mode: result.mode,
        failures,
      })
    } catch (error) {
      outcomes.push({
        id: testCase.id,
        ok: false,
        latencyMs: Date.now() - started,
        mode: 'invalid',
        failures: [error instanceof Error ? error.message : 'erro desconhecido'],
      })
    } finally {
      delete process.env['FAKE_EXECUTION_OUTPUT']
    }
  }

  await disposeCatalogProviders()

  const passed = outcomes.filter((outcome) => outcome.ok).length
  const failed = outcomes.length - passed
  const latencies = outcomes.map((outcome) => outcome.latencyMs)
  const summary = {
    file,
    mode,
    cases: outcomes.length,
    passed,
    failed,
    avgLatencyMs:
      latencies.length > 0 ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : 0,
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
      `\ncasos=${summary.cases} ok=${passed} falhas=${failed} latencia_media=${summary.avgLatencyMs}ms p95=${summary.p95LatencyMs}ms`,
    )
  }

  if (failed > 0 && !hasFlag('allow-fail')) process.exitCode = 1
}

main().catch((error) => {
  console.error('ERRO:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
