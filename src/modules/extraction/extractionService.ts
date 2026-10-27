import { getProfile } from '../../config/profiles.ts'
import ExecutionService from '../execution/executionService.ts'
import { extractRawCards, type RawCard } from './extractCards.ts'
import type { ExtractedCard, ExtractionResult } from './types.ts'

function candidateId(cardId: string, prefix: string, index: number): string {
  return `${cardId}${prefix}${index + 1}`
}

function deterministicCard(raw: RawCard, cardId: string): ExtractedCard {
  return {
    cardId,
    externalProductId: raw.externalProductId,
    permalink: raw.permalink,
    title: raw.title,
    priceCents: raw.priceCents,
    currency: raw.currency,
    originalPriceCents:
      raw.originalPriceCents !== null && raw.originalPriceCents > raw.priceCents ? raw.originalPriceCents : null,
    imageUrl: raw.imageUrl,
    candidates: {
      titles: [{ id: candidateId(cardId, 't', 0), text: raw.title }],
      prices: [
        { id: candidateId(cardId, 'p', 0), cents: raw.priceCents, currency: raw.currency, kind: 'current', text: raw.priceQuote },
        ...(raw.originalPriceCents !== null && raw.originalPriceCents > raw.priceCents
          ? [{
              id: candidateId(cardId, 'p', 1),
              cents: raw.originalPriceCents,
              currency: raw.currency,
              kind: 'original' as const,
              text: raw.priceQuote,
            }]
          : []),
      ],
      images: [{ id: candidateId(cardId, 'i', 0), url: raw.imageUrl }],
    },
    evidence: {
      cardRoot: { selector: raw.cardRootSelector, occurrence: 0 },
      title: { source: raw.source, quote: raw.titleQuote },
      price: { source: raw.source, quote: raw.priceQuote },
      image: { source: raw.source, quote: raw.imageQuote },
    },
    confidence: 0.85,
    needsReview: false,
    reviewReasons: [],
  }
}

function buildPack(marketplace: string, cards: RawCard[]): Record<string, unknown> {
  return {
    marketplace,
    cards: cards.map((raw, index) => {
      const cardId = `c${index + 1}`
      return {
        cardId,
        titleCandidates: [{ id: candidateId(cardId, 't', 0), text: raw.title }],
        priceCandidates: [
          {
            id: candidateId(cardId, 'p', 0),
            text: raw.priceQuote,
            currency: raw.currency,
            cents: raw.priceCents,
            kind: 'current',
          },
          ...(raw.originalPriceCents !== null && raw.originalPriceCents > raw.priceCents
            ? [{
                id: candidateId(cardId, 'p', 1),
                text: raw.priceQuote,
                currency: raw.currency,
                cents: raw.originalPriceCents,
                kind: 'original',
              }]
            : []),
        ],
        imageCandidates: [{ id: candidateId(cardId, 'i', 0), url: raw.imageUrl }],
      }
    }),
  }
}

function findCandidate<T extends { id: string }>(items: T[], id: string | null): T | null {
  if (!id) return null
  return items.find((item) => item.id === id) ?? null
}

interface AppliedExecution {
  cards: ExtractedCard[]
  rejectedIds: Set<string>
}

function applyExecution(
  rawCards: RawCard[],
  result: Awaited<ReturnType<typeof ExecutionService.execute>>,
  minConfidence: number,
): AppliedExecution {
  const rejectedIds = new Set<string>()
  if (!result.output || !Array.isArray(result.output['items'])) return { cards: [], rejectedIds }
  const out: ExtractedCard[] = []
  for (const rawItem of result.output['items']) {
    if (typeof rawItem !== 'object' || rawItem === null) continue
    const item = rawItem as Record<string, unknown>
    const itemNumber = Number(item['item'])
    if (!Number.isInteger(itemNumber) || itemNumber < 1 || itemNumber > rawCards.length) continue
    const raw = rawCards[itemNumber - 1]
    if (!raw) continue
    const cardId = `c${itemNumber}`
    if (item['isProduct'] === false) {
      rejectedIds.add(cardId)
      continue
    }
    const base = deterministicCard(raw, cardId)
    const title = findCandidate(base.candidates.titles, typeof item['title'] === 'string' ? item['title'] : null)
    const price = findCandidate(base.candidates.prices, typeof item['price'] === 'string' ? item['price'] : null)
    const original = findCandidate(
      base.candidates.prices,
      typeof item['original'] === 'string' ? item['original'] : null,
    )
    const image = findCandidate(base.candidates.images, typeof item['image'] === 'string' ? item['image'] : null)
    const confidenceRaw = Number(item['confidence'])
    const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw > 1 ? confidenceRaw / 100 : confidenceRaw)) : 0.4
    out.push({
      ...base,
      title: title?.text ?? base.title,
      priceCents: price?.cents ?? base.priceCents,
      originalPriceCents:
        original && original.cents > (price?.cents ?? base.priceCents) ? original.cents : null,
      imageUrl: image?.url ?? base.imageUrl,
      confidence,
      needsReview: confidence < minConfidence,
      reviewReasons: confidence < minConfidence ? ['low_confidence'] : [],
    })
  }
  return { cards: out, rejectedIds }
}

export default class ExtractionService {
  static async extract(input: {
    marketplace: string
    url: string
    html: string
    profile: string
    maxScanned: number
    maxCards: number
    maxLlmCards: number
    mode: string
  }): Promise<ExtractionResult> {
    const { cards: rawCards, truncated } = extractRawCards(input.html, input.marketplace, input.url, input.maxScanned)
    if (rawCards.length === 0) {
      return {
        marketplace: input.marketplace,
        cards: [],
        rejected: [],
        scanned: 0,
        truncated: false,
        coverageComplete: false,
        quality: 'no_cards',
        mode: 'fallback',
        execution: null,
      }
    }

    const limited = rawCards.slice(0, input.maxCards)
    const llmCards = Math.min(30, Math.max(0, input.maxLlmCards))
    let execution: Awaited<ReturnType<typeof ExecutionService.execute>> | null = null
    let applied: AppliedExecution = { cards: [], rejectedIds: new Set() }
    try {
      const profile = getProfile(input.profile)
      if (profile && llmCards > 0) {
        execution = await ExecutionService.execute({
          profile: input.profile,
          input: buildPack(input.marketplace, limited.slice(0, llmCards)),
          options: { mode: input.mode as 'off' | 'shadow' | 'assist' | 'on' },
        })
        applied = applyExecution(
          limited.slice(0, llmCards),
          execution,
          profile.profile.validation.minConfidence ?? 0.6,
        )
      }
    } catch (error) {
      console.warn('[extraction] adjudication failed:', error instanceof Error ? error.message : error)
    }

    // Cobertura: usa o resultado do modelo quando houver; cards sem saída do
    // modelo caem no determinístico (o modelo só vê `maxLlmCards`). `isProduct:false`
    // explícito é o ÚNICO caso de descarte por decisão do modelo.
    const byId = new Map(applied.cards.map((card) => [card.cardId, card]))
    const cards: ExtractedCard[] = []
    limited.forEach((raw, index) => {
      const cardId = `c${index + 1}`
      if (applied.rejectedIds.has(cardId)) return
      cards.push(byId.get(cardId) ?? deterministicCard(raw, cardId))
    })

    const accounted = new Set(cards.map((card) => card.cardId))
    const rejected = limited
      .map((_raw, index) => `c${index + 1}`)
      .filter((cardId) => !accounted.has(cardId))
      .map((cardId) => ({ cardId, reason: 'not_a_product' }))

    return {
      marketplace: input.marketplace,
      cards,
      rejected,
      scanned: rawCards.length,
      truncated: truncated || rawCards.length > limited.length,
      coverageComplete: !truncated && rawCards.length === limited.length,
      quality: truncated || rawCards.length > limited.length ? 'partial' : 'ok',
      mode: execution?.mode ?? 'heuristic',
      execution,
    }
  }
}
