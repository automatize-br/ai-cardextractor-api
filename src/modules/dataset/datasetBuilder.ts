import { buildUserPrompt, SYSTEM_PROMPT } from '../../providers/llm/prompt.ts'
import { letterFor } from '../../providers/llm/grammar.ts'
import { ApiError } from '../../exceptions/ApiError.ts'
import type {
  AdjudicationCard,
  AdjudicationDecision,
  AdjudicationPack,
  AdjudicationRejection,
} from '../../types/adjudication.ts'
import type { ReplayRecord, ReplayShadowChoice } from '../../types/replay.ts'

// ============================================================================
// Dataset de treino (F6) a partir de replays `shadow` + correções humanas.
//
// Regras:
// - a IA só escolhe LETRAS de candidatos existentes; o dataset nunca inventa.
// - rótulo humano > escolha shadow > decisão do modelo (distilação).
// - split por marketplace (domínio); com <3 domínios cai para hash do pack.
// - gera também `test.eval.jsonl` no formato do harness (npm run eval).
// ============================================================================

export interface HumanLabel {
  packHash: string
  cardId: string
  titleId?: string | null
  reject?: string | null
  confidence?: number
}

export type SplitName = 'train' | 'valid' | 'test'
export type SplitStrategy = 'marketplace' | 'hash'

export interface DatasetMessages {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
}

export interface EvalCase {
  id: string
  pack: AdjudicationPack
  expect: {
    decisions: Record<string, { titleId: string | null; priceId: string | null; originalPriceId: string | null; imageId: string | null }>
    rejected: Record<string, string>
  }
}

export interface DatasetExample extends DatasetMessages {
  packHash: string
  marketplace: string
  split: SplitName
  evalCase: EvalCase
}

export interface DatasetStats {
  replays: number
  invalidReplays: number
  invalidLabels: number
  uniquePacks: number
  examples: number
  cards: number
  labeledCards: number
  skippedCards: number
  labelSources: { human: number; shadow: number; model: number }
  splitStrategy: SplitStrategy
  splits: Record<SplitName, number>
  marketplaces: string[]
}

export interface DatasetBuildResult {
  examples: DatasetExample[]
  stats: DatasetStats
}

export interface BuildDatasetOptions {
  splitStrategy?: SplitStrategy | 'auto'
}

interface ParsedLines<T> {
  items: T[]
  invalid: number
}

interface AnswerItem {
  c: number
  p: 0 | 1
  t: string
  pr: string
  o: string
  i: string
  cf: number
}

interface LabeledCard {
  card: AdjudicationCard
  answer: AnswerItem
  titleId: string | null
  reject: string | null
  decision: AdjudicationDecision | undefined
  source: 'human' | 'shadow' | 'model'
}

const HTTP_URL = /^https?:\/\//i

export function labelKey(packHash: string, cardId: string): string {
  return `${packHash}\u0000${cardId}`
}

export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function splitFor(key: string): SplitName {
  const bucket = fnv1a(key) % 10
  if (bucket < 8) return 'train'
  if (bucket === 8) return 'valid'
  return 'test'
}

export function parseReplays(text: string): ParsedLines<ReplayRecord> {
  const items: ReplayRecord[] = []
  let invalid = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    try {
      const value = JSON.parse(line) as Partial<ReplayRecord>
      const pack = value.pack as AdjudicationPack | null | undefined
      if (
        typeof value.packHash !== 'string' ||
        typeof value.marketplace !== 'string' ||
        !pack ||
        !Array.isArray(pack.cards) ||
        !Array.isArray(value.decisions) ||
        !Array.isArray(value.rejected)
      ) {
        invalid += 1
        continue
      }
      items.push(value as ReplayRecord)
    } catch {
      invalid += 1
    }
  }
  return { items, invalid }
}

export function parseLabels(text: string): ParsedLines<HumanLabel> {
  const items: HumanLabel[] = []
  let invalid = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    try {
      const value = JSON.parse(line) as Partial<HumanLabel>
      if (typeof value.packHash !== 'string' || typeof value.cardId !== 'string') {
        invalid += 1
        continue
      }
      items.push(value as HumanLabel)
    } catch {
      invalid += 1
    }
  }
  return { items, invalid }
}

function letterOf(ids: string[], id: string | null | undefined): string | null {
  if (!id) return '-'
  const index = ids.indexOf(id)
  return index >= 0 ? letterFor(index) : null
}

function uniqueCurrentPrice(card: AdjudicationCard): string | null {
  const currents = card.priceCandidates.filter(
    (price) => price.currency === 'BRL' && price.kind === 'current' && price.cents > 0,
  )
  if (new Set(currents.map((price) => price.cents)).size !== 1) return null
  return currents[0]?.id ?? null
}

function heuristicOriginal(card: AdjudicationCard, priceId: string | null): string | null {
  if (!priceId) return null
  const price = card.priceCandidates.find((candidate) => candidate.id === priceId)
  if (!price) return null
  return (
    [...card.priceCandidates]
      .filter((candidate) => candidate.kind === 'original' && candidate.currency === 'BRL' && candidate.cents > price.cents)
      .sort((left, right) => right.cents - left.cents)[0]?.id ?? null
  )
}

function resolveLabel(
  cardId: string,
  labels: Map<string, HumanLabel>,
  replay: ReplayRecord,
  decisions: Map<string, AdjudicationDecision>,
  shadow: Map<string, ReplayShadowChoice>,
): { titleId: string | null; reject: string | null; confidence: number | null; source: LabeledCard['source'] } | null {
  const human = labels.get(labelKey(replay.packHash, cardId))
  if (human) {
    const reject = human.reject?.trim() ? human.reject.trim() : null
    if (reject) return { titleId: null, reject, confidence: null, source: 'human' }
    if (human.titleId) {
      return { titleId: human.titleId, reject: null, confidence: human.confidence ?? 90, source: 'human' }
    }
  }

  const shadowChoice = shadow.get(cardId)
  if (shadowChoice) {
    if (shadowChoice.isProduct === false) {
      return { titleId: null, reject: 'not_a_product', confidence: null, source: 'shadow' }
    }
    if (shadowChoice.titleId) {
      return {
        titleId: shadowChoice.titleId,
        reject: null,
        confidence: shadowChoice.confidence > 0 ? shadowChoice.confidence : null,
        source: 'shadow',
      }
    }
  }

  const decision = decisions.get(cardId)
  if (decision?.source === 'model' && decision.titleId) {
    return { titleId: decision.titleId, reject: null, confidence: decision.confidence, source: 'model' }
  }
  return null
}

function buildLabeledCard(
  card: AdjudicationCard,
  label: { titleId: string | null; reject: string | null; confidence: number | null; source: LabeledCard['source'] },
  decision: AdjudicationDecision | undefined,
): LabeledCard | null {
  if (label.reject) {
    return {
      card,
      answer: { c: 0, p: 0, t: '-', pr: '-', o: '-', i: '-', cf: 0 },
      titleId: null,
      reject: label.reject,
      decision,
      source: label.source,
    }
  }

  const titleId = label.titleId
  if (!titleId) return null
  const titleLetter = letterOf(
    card.titleCandidates.map((candidate) => candidate.id),
    titleId,
  )
  if (!titleLetter || titleLetter === '-') return null

  const priceId = decision?.priceId ?? uniqueCurrentPrice(card)
  const priceLetter = letterOf(
    card.priceCandidates.map((candidate) => candidate.id),
    priceId,
  )
  if (!priceLetter || priceLetter === '-') return null

  const originalId = decision?.originalPriceId ?? heuristicOriginal(card, priceId)
  const imageId = decision?.imageId ?? card.imageCandidates.find((image) => HTTP_URL.test(image.url))?.id ?? null
  const originalLetter = letterOf(
    card.priceCandidates.map((candidate) => candidate.id),
    originalId,
  )
  const imageLetter = letterOf(
    card.imageCandidates.map((candidate) => candidate.id),
    imageId,
  )
  if (originalLetter === null || imageLetter === null) return null

  const rawConfidence = label.confidence ?? decision?.confidence ?? 0.9
  const confidence = Math.max(0, Math.min(100, Math.round(rawConfidence * 100)))

  return {
    card,
    answer: {
      c: 0,
      p: 1,
      t: titleLetter,
      pr: priceLetter,
      o: originalLetter,
      i: imageLetter,
      cf: confidence,
    },
    titleId,
    reject: null,
    decision,
    source: label.source,
  }
}

export function buildDataset(
  replays: ReplayRecord[],
  labels: HumanLabel[] = [],
  options: BuildDatasetOptions = {},
): DatasetBuildResult {
  const labelMap = new Map(labels.map((label) => [labelKey(label.packHash, label.cardId), label]))
  const byHash = new Map<string, ReplayRecord>()
  for (const replay of replays) {
    const existing = byHash.get(replay.packHash)
    if (!existing || String(replay.capturedAt ?? '') >= String(existing.capturedAt ?? '')) {
      byHash.set(replay.packHash, replay)
    }
  }

  const unique = [...byHash.values()]
  const marketplaces = [...new Set(unique.map((replay) => replay.marketplace))].sort()
  const splitStrategy: SplitStrategy =
    options.splitStrategy === 'marketplace' || options.splitStrategy === 'hash'
      ? options.splitStrategy
      : marketplaces.length >= 3
        ? 'marketplace'
        : 'hash'

  const examples: DatasetExample[] = []
  const stats: DatasetStats = {
    replays: replays.length,
    invalidReplays: 0,
    invalidLabels: 0,
    uniquePacks: unique.length,
    examples: 0,
    cards: 0,
    labeledCards: 0,
    skippedCards: 0,
    labelSources: { human: 0, shadow: 0, model: 0 },
    splitStrategy,
    splits: { train: 0, valid: 0, test: 0 },
    marketplaces,
  }

  for (const replay of unique) {
    const pack = replay.pack
    if (!pack) continue
    const decisions = new Map(replay.decisions.map((decision) => [decision.cardId, decision]))
    const rejections = new Map<string, string>(
      replay.rejected.map((rejection: AdjudicationRejection) => [rejection.cardId, rejection.reason]),
    )
    const shadow = new Map<string, ReplayShadowChoice>(
      (replay.shadow ?? []).map((choice) => [choice.cardId, choice]),
    )

    const labeled: LabeledCard[] = []
    for (const card of pack.cards) {
      stats.cards += 1
      const label = resolveLabel(card.cardId, labelMap, replay, decisions, shadow)
      if (!label) {
        stats.skippedCards += 1
        continue
      }
      const built = buildLabeledCard(card, label, decisions.get(card.cardId))
      if (!built) {
        stats.skippedCards += 1
        continue
      }
      // Rejeição vinda da decisão final (sem shadow/humano) também é rótulo.
      if (!built.reject && rejections.has(card.cardId) && !label.titleId) {
        stats.skippedCards += 1
        continue
      }
      labeled.push(built)
    }

    if (labeled.length === 0) continue

    const filteredPack: AdjudicationPack = {
      packVersion: pack.packVersion,
      marketplace: pack.marketplace,
      packHash: null,
      cards: labeled.map((entry) => entry.card),
    }
    const answers = labeled.map((entry, index) => ({ ...entry.answer, c: index + 1 }))
    const expect: EvalCase['expect'] = { decisions: {}, rejected: {} }
    for (const entry of labeled) {
      if (entry.reject) {
        expect.rejected[entry.card.cardId] = entry.reject
        stats.labelSources[entry.source] += 1
        continue
      }
      if (!entry.decision && !entry.titleId) continue
      expect.decisions[entry.card.cardId] = {
        titleId: entry.titleId,
        priceId: entry.decision?.priceId ?? uniqueCurrentPrice(entry.card),
        originalPriceId: entry.decision?.originalPriceId ?? heuristicOriginal(entry.card, uniqueCurrentPrice(entry.card)),
        imageId:
          entry.decision?.imageId ??
          entry.card.imageCandidates.find((image) => HTTP_URL.test(image.url))?.id ??
          null,
      }
      stats.labelSources[entry.source] += 1
    }

    const splitKey = splitStrategy === 'marketplace' ? replay.marketplace : replay.packHash
    const split = splitFor(splitKey)
    const id = `${replay.marketplace}-${replay.packHash.slice(0, 12)}-${examples.length + 1}`

    examples.push({
      packHash: replay.packHash,
      marketplace: replay.marketplace,
      split,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(filteredPack) },
        { role: 'assistant', content: JSON.stringify({ d: answers }) },
      ],
      evalCase: { id, pack: filteredPack, expect },
    })
    stats.labeledCards += labeled.length
    stats.splits[split] += 1
  }

  stats.examples = examples.length
  return { examples, stats }
}

export function buildDatasetFromText(
  replaysText: string,
  labelsText = '',
  options: BuildDatasetOptions = {},
): DatasetBuildResult & { invalidReplays: number; invalidLabels: number } {
  const replays = parseReplays(replaysText)
  const labels = parseLabels(labelsText)
  const result = buildDataset(replays.items, labels.items, options)
  result.stats.invalidReplays = replays.invalid
  result.stats.invalidLabels = labels.invalid
  return { ...result, invalidReplays: replays.invalid, invalidLabels: labels.invalid }
}

export function assertBuildable(result: DatasetBuildResult): void {
  if (result.examples.length === 0) {
    throw ApiError.badRequest(
      'Nenhum exemplo gerado: verifique se há replays shadow/labels válidos (AI_REPLAY_PATH).',
      'VALIDATION_ERROR',
    )
  }
}
