// Relatório de rollout (F7) sobre os replays shadow.
//
//   npm run rollout:report
//   npm run rollout:report -- --in data/replays.jsonl --min-packs 200 --min-valid 0.99
//   npm run rollout:report -- --json --allow-fail
//
// Exit code 1 quando algum gate do plano §11 falha (use --allow-fail p/ ignorar).
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseReplays } from '../src/modules/dataset/datasetBuilder.ts'
import {
  computeRolloutMetrics,
  evaluateRollout,
  DEFAULT_GATES,
} from '../src/modules/rollout/rolloutReport.ts'
import type { RolloutGates } from '../src/modules/rollout/rolloutReport.ts'

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : fallback
}

function numberArg(name: string, fallback: number): number {
  const raw = argValue(name, '')
  const parsed = Number(raw)
  return raw !== '' && Number.isFinite(parsed) ? parsed : fallback
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function main(): void {
  const input = resolve(argValue('in', 'data/replays.jsonl'))
  if (!existsSync(input)) {
    console.error(`Replays não encontrados: ${input}`)
    process.exitCode = 1
    return
  }

  const parsed = parseReplays(readFileSync(input, 'utf8'))
  const metrics = computeRolloutMetrics(parsed.items)
  const gates: RolloutGates = {
    minPacks: numberArg('min-packs', DEFAULT_GATES.minPacks),
    minValidRate: numberArg('min-valid', DEFAULT_GATES.minValidRate),
    minShadowCoverage: numberArg('min-shadow', DEFAULT_GATES.minShadowCoverage),
    maxP95LatencyMs: numberArg('max-p95', 0) > 0 ? numberArg('max-p95', 0) : null,
  }
  const evaluation = evaluateRollout(metrics, gates)

  if (hasFlag('json')) {
    console.log(JSON.stringify({ input, metrics, gates, evaluation, invalidLines: parsed.invalid }, null, 2))
  } else {
    console.log(`arquivo=${input} linhas_invalidas=${parsed.invalid}`)
    console.log(
      `packs=${metrics.packs} válidos=${metrics.validPacks} (${percent(metrics.validRate)}) ` +
        `shadow=${metrics.shadowPacks} (${percent(metrics.shadowCoverage)})`,
    )
    console.log(
      `decisões_modelo=${metrics.modelDecisions} confiança_média=${metrics.avgConfidence.toFixed(2)} ` +
        `baixa_confiança=${percent(metrics.lowConfidenceRate)} concordância=${percent(metrics.agreementRate)} ` +
        `(${metrics.agreementSamples} amostras)`,
    )
    console.log(`latência média=${metrics.avgLatencyMs}ms p95=${metrics.p95LatencyMs}ms`)
    console.log(evaluation.passed ? 'GATES: OK' : `GATES: FALHOU\n - ${evaluation.failures.join('\n - ')}`)
  }

  if (!evaluation.passed && !hasFlag('allow-fail')) process.exitCode = 1
}

main()
