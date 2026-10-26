import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  computeRolloutMetrics,
  DEFAULT_GATES,
  evaluateRollout,
  percentile,
} from '../../src/modules/rollout/rolloutReport.ts'
import { makeCard, makePack } from '../packFixture.ts'
import type { ReplayRecord } from '../../src/types/replay.ts'

const decision = (overrides: Partial<ReplayRecord['decisions'][number]> = {}): ReplayRecord['decisions'][number] => ({
  cardId: 'c1',
  source: 'heuristic',
  isProduct: true,
  titleId: 't_c1',
  priceId: 'p_c1',
  originalPriceId: 'o_c1',
  imageId: 'i_c1',
  confidence: 0.4,
  needsReview: true,
  reviewReasons: [],
  ...overrides,
})

function replay(overrides: Partial<ReplayRecord> = {}): ReplayRecord {
  const pack = makePack([makeCard('c1')])
  return {
    capturedAt: '2026-10-21T10:00:00.000Z',
    packHash: 'a'.repeat(64),
    packVersion: '1',
    marketplace: 'amazon',
    mode: 'heuristic',
    modelId: 'qwen',
    modelVersion: 'qwen@1',
    promptVersion: '1',
    latencyMs: 1000,
    pack,
    decisions: [decision()],
    rejected: [],
    shadow: [{ cardId: 'c1', isProduct: true, titleId: 't_c1', confidence: 0.9 }],
    ...overrides,
  }
}

function withHash(suffix: string, overrides: Partial<ReplayRecord> = {}): ReplayRecord {
  return replay({ packHash: suffix.repeat(64).slice(0, 64), ...overrides })
}

test('conta packs válidos, cobertura shadow e concordância', () => {
  const metrics = computeRolloutMetrics([
    withHash('a'),
    withHash('b', { shadow: [{ cardId: 'c1', isProduct: true, titleId: 't_outro', confidence: 0.5 }] }),
    withHash('c', { fallbackReason: 'MODEL_TIMEOUT', shadow: null }),
    withHash('d', { rejected: [{ cardId: 'c1', reason: 'invalid_model_output' }], decisions: [], shadow: null }),
    withHash('e', { shadow: null, decisions: [decision({ reviewReasons: ['ambiguous_title'] })] }),
  ])

  assert.equal(metrics.packs, 5)
  assert.equal(metrics.validPacks, 3)
  assert.equal(metrics.validRate, 3 / 5)
  assert.equal(metrics.shadowPacks, 2)
  assert.equal(metrics.pendingCards, 3)
  assert.equal(metrics.shadowCards, 2)
  assert.equal(metrics.shadowCoverage, 2 / 3)
  assert.equal(metrics.modelDecisions, 2)
  assert.equal(metrics.agreementSamples, 2)
  assert.equal(metrics.agreementRate, 0.5)
  assert.equal(metrics.lowConfidenceRate, 1 / 2)
})

test('dedupe por packHash usa o replay mais recente', () => {
  const metrics = computeRolloutMetrics([
    withHash('a', { capturedAt: '2026-10-20T10:00:00.000Z', fallbackReason: 'OLD' }),
    withHash('a', { capturedAt: '2026-10-21T10:00:00.000Z' }),
  ])
  assert.equal(metrics.replays, 2)
  assert.equal(metrics.packs, 1)
  assert.equal(metrics.validPacks, 1)
})

test('latência média e p95', () => {
  const values = [100, 200, 300, 1000, 2000]
  const metrics = computeRolloutMetrics(
    values.map((latencyMs, index) => withHash(String(index + 1), { latencyMs })),
  )
  assert.equal(metrics.avgLatencyMs, 720)
  assert.equal(metrics.p95LatencyMs, 2000)
  assert.equal(percentile([], 95), 0)
})

test('gates do plano: packs, validade, shadow e p95', () => {
  const ok = evaluateRollout(
    {
      replays: 200,
      packs: 200,
      validPacks: 200,
      validRate: 1,
      shadowPacks: 200,
      pendingCards: 200,
      shadowCards: 200,
      shadowCoverage: 1,
      modelDecisions: 200,
      avgConfidence: 0.9,
      lowConfidenceRate: 0,
      avgLatencyMs: 100,
      p95LatencyMs: 500,
      agreementSamples: 200,
      agreementRate: 0.9,
    },
    { ...DEFAULT_GATES, maxP95LatencyMs: 1000 },
  )
  assert.equal(ok.passed, true)

  const failed = evaluateRollout(
    {
      replays: 10,
      packs: 10,
      validPacks: 9,
      validRate: 0.9,
      shadowPacks: 5,
      pendingCards: 10,
      shadowCards: 5,
      shadowCoverage: 0.5,
      modelDecisions: 5,
      avgConfidence: 0.5,
      lowConfidenceRate: 0.6,
      avgLatencyMs: 9000,
      p95LatencyMs: 12000,
      agreementSamples: 5,
      agreementRate: 0.2,
    },
    { ...DEFAULT_GATES, maxP95LatencyMs: 1000 },
  )
  assert.equal(failed.passed, false)
  assert.equal(failed.failures.length, 4)
})
