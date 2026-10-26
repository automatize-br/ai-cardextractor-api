import type { ReplayRecord } from '../../types/replay.ts'

// ============================================================================
// Métricas de rollout (F7) a partir dos replays shadow (AI_REPLAY_PATH).
//
// Gates do plano §11:
//   shadow: >= 200 packs e >= 99% de packs válidos (sem fallback/validação).
//   assist/on: só depois do shadow aprovado + eval sem regressão de latência.
// ============================================================================

export interface RolloutMetrics {
  replays: number
  packs: number
  validPacks: number
  validRate: number
  shadowPacks: number
  /** Cards que precisaram do modelo (título ambíguo) e quantos tiveram escolha shadow. */
  pendingCards: number
  shadowCards: number
  shadowCoverage: number
  modelDecisions: number
  avgConfidence: number
  lowConfidenceRate: number
  avgLatencyMs: number
  p95LatencyMs: number
  agreementSamples: number
  agreementRate: number
}

export interface RolloutGates {
  minPacks: number
  minValidRate: number
  minShadowCoverage: number
  maxP95LatencyMs: number | null
}

export interface RolloutEvaluation {
  passed: boolean
  failures: string[]
}

export const DEFAULT_GATES: RolloutGates = {
  minPacks: 200,
  minValidRate: 0.99,
  minShadowCoverage: 0.99,
  maxP95LatencyMs: null,
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[index] ?? 0
}

function latestByPack(replays: ReplayRecord[]): ReplayRecord[] {
  const byHash = new Map<string, ReplayRecord>()
  for (const replay of replays) {
    const existing = byHash.get(replay.packHash)
    if (!existing || String(replay.capturedAt ?? '') >= String(existing.capturedAt ?? '')) {
      byHash.set(replay.packHash, replay)
    }
  }
  return [...byHash.values()]
}

function isValidPack(replay: ReplayRecord): boolean {
  const cards = replay.pack?.cards.length ?? 0
  if (cards === 0) return false
  if (replay.fallbackReason !== null && replay.fallbackReason !== undefined) return false
  if (replay.rejected.some((item) => item.reason === 'invalid_model_output')) return false
  return replay.decisions.length + replay.rejected.length >= cards
}

export function computeRolloutMetrics(
  replays: ReplayRecord[],
  minConfidence = 0.6,
): RolloutMetrics {
  const unique = latestByPack(replays)
  const valid = unique.filter(isValidPack)

  let shadowPacks = 0
  let pendingCards = 0
  let shadowCards = 0
  let modelDecisions = 0
  let confidenceSum = 0
  let lowConfidence = 0
  let agreementSamples = 0
  let agreements = 0
  const latencies: number[] = []

  for (const replay of unique) {
    if (Number.isFinite(replay.latencyMs) && replay.latencyMs >= 0) latencies.push(replay.latencyMs)
    const shadow = replay.shadow ?? []
    if (shadow.length > 0) shadowPacks += 1

    const decisions = new Map(replay.decisions.map((decision) => [decision.cardId, decision]))
    const pendingIds = new Set<string>()
    for (const decision of replay.decisions) {
      if (decision.reviewReasons.includes('ambiguous_title')) pendingIds.add(decision.cardId)
    }
    for (const choice of shadow) pendingIds.add(choice.cardId)
    pendingCards += pendingIds.size
    shadowCards += shadow.filter((choice) => choice.titleId !== null).length
    for (const choice of shadow) {
      if (!choice.titleId) continue
      modelDecisions += 1
      confidenceSum += choice.confidence
      if (choice.confidence < minConfidence) lowConfidence += 1
      const final = decisions.get(choice.cardId)
      if (final?.titleId) {
        agreementSamples += 1
        if (final.titleId === choice.titleId) agreements += 1
      }
    }
  }

  const packs = unique.length
  return {
    replays: replays.length,
    packs,
    validPacks: valid.length,
    validRate: packs === 0 ? 0 : valid.length / packs,
    shadowPacks,
    pendingCards,
    shadowCards,
    // Sem nenhum card pendente não há o que cobrir (gate vacuamente satisfeito).
    shadowCoverage:
      pendingCards === 0 ? (packs === 0 ? 0 : 1) : Math.min(1, shadowCards / pendingCards),
    modelDecisions,
    avgConfidence: modelDecisions === 0 ? 0 : confidenceSum / modelDecisions,
    lowConfidenceRate: modelDecisions === 0 ? 0 : lowConfidence / modelDecisions,
    avgLatencyMs:
      latencies.length === 0 ? 0 : Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
    p95LatencyMs: Math.round(percentile(latencies, 95)),
    agreementSamples,
    agreementRate: agreementSamples === 0 ? 0 : agreements / agreementSamples,
  }
}

export function evaluateRollout(metrics: RolloutMetrics, gates: RolloutGates): RolloutEvaluation {
  const failures: string[] = []
  if (metrics.packs < gates.minPacks) {
    failures.push(`packs ${metrics.packs} < ${gates.minPacks}`)
  }
  if (metrics.validRate < gates.minValidRate) {
    failures.push(`packs válidos ${(metrics.validRate * 100).toFixed(2)}% < ${(gates.minValidRate * 100).toFixed(2)}%`)
  }
  if (metrics.shadowCoverage < gates.minShadowCoverage) {
    failures.push(
      `cobertura shadow ${(metrics.shadowCoverage * 100).toFixed(2)}% < ${(gates.minShadowCoverage * 100).toFixed(2)}%`,
    )
  }
  if (gates.maxP95LatencyMs !== null && metrics.p95LatencyMs > gates.maxP95LatencyMs) {
    failures.push(`p95 ${metrics.p95LatencyMs}ms > ${gates.maxP95LatencyMs}ms`)
  }
  return { passed: failures.length === 0, failures }
}
