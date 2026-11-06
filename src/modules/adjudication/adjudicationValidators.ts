import { z } from 'zod'
import { env } from '../../config/env.ts'
import { PACK_VERSION, PRICE_KINDS } from '../../enums/adjudication.ts'
import { ApiError } from '../../exceptions/ApiError.ts'
import { safeParseJsonObject, toFiniteNumber, toNonEmptyString } from '../../helpers/safeParseJson.ts'
import { computePackHash } from '../../helpers/packHash.ts'
import { indexForLetter, NONE_LETTER } from '../../providers/llm/candidateRef.ts'
import type {
  AdjudicationCard,
  AdjudicationDecision,
  AdjudicationPack,
  AdjudicationRejection,
  RejectionReason,
} from '../../types/adjudication.ts'

// ============================================================================
// Validacao do pack (entrada) e da resposta do modelo (saida). Toda decisao e
// revalidada contra o pack: IDs precisam existir, preco precisa ser current
// BRL e nao ambiguo, original precisa ser maior que o atual.
// ============================================================================

const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

const idSchema = z.string().regex(ID_PATTERN, 'invalid opaque id')
const titleSchema = z.object({ id: idSchema, text: z.string().min(1).max(300) })
const priceSchema = z.object({
  id: idSchema,
  text: z.string().max(64),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be ISO-4217'),
  cents: z.number().int().min(0).max(100_000_000),
  kind: z.enum(PRICE_KINDS),
})
const imageSchema = z.object({ id: idSchema, url: z.string().url().max(2000) })
const contextSchema = z.object({
  position: z.number().int().nullable(),
  breadcrumb: z.string().max(200).nullable(),
})
const cardSchema = z.object({
  cardId: idSchema,
  host: z.string().min(3).max(255),
  titleCandidates: z.array(titleSchema).max(12),
  priceCandidates: z.array(priceSchema).max(12),
  imageCandidates: z.array(imageSchema).max(12),
  // `context` e opcional no contrato: ausente vira posicao/breadcrumb nulos.
  context: contextSchema.default({ position: null, breadcrumb: null }),
})
const packSchema = z.object({
  packVersion: z.literal(PACK_VERSION),
  marketplace: z.string().min(1).max(64),
  packHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  cards: z.array(cardSchema).min(1).max(env.LLM_MAX_CARDS),
})

export interface ModelOutputParse {
  decisions: AdjudicationDecision[]
  rejected: AdjudicationRejection[]
  validationFailures: number
}

function reject(cardId: string, reason: RejectionReason): AdjudicationRejection {
  return { cardId, reason }
}

function readArrayItem(value: unknown, index: number): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null
  const item = value[index]
  if (typeof item !== 'object' || item === null) return null
  return item as Record<string, unknown>
}

export function validatePack(raw: unknown): AdjudicationPack {
  if (typeof raw === 'object' && raw !== null) {
    const cards = (raw as { cards?: unknown }).cards
    if (Array.isArray(cards) && cards.length > env.LLM_MAX_CARDS) {
      throw ApiError.badRequest(
        `Pack exceeds ${env.LLM_MAX_CARDS} cards`,
        'PACK_TOO_LARGE',
        { cards: cards.length, limit: env.LLM_MAX_CARDS },
      )
    }
  }

  const parsed = packSchema.safeParse(raw)
  if (!parsed.success) {
    throw ApiError.badRequest(
      'Invalid adjudication pack',
      'PACK_INVALID',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    )
  }

  const pack = parsed.data as AdjudicationPack
  const cardIds = new Set<string>()
  const candidateIds = new Set<string>()

  for (const card of pack.cards) {
    if (cardIds.has(card.cardId)) {
      throw ApiError.badRequest(`Duplicate cardId: ${card.cardId}`, 'PACK_INVALID')
    }
    cardIds.add(card.cardId)

    const ids = [
      ...card.titleCandidates.map((item) => item.id),
      ...card.priceCandidates.map((item) => item.id),
      ...card.imageCandidates.map((item) => item.id),
    ]
    for (const id of ids) {
      if (candidateIds.has(id)) {
        throw ApiError.badRequest(`Duplicate candidate id: ${id}`, 'PACK_INVALID')
      }
      candidateIds.add(id)
    }
  }

  return pack
}

/** Hash canonico do pack (o campo packHash nao entra no calculo). */
export function packContentHash(pack: AdjudicationPack): string {
  return computePackHash({
    packVersion: pack.packVersion,
    marketplace: pack.marketplace,
    cards: pack.cards,
  })
}

export function assertPackHash(pack: AdjudicationPack): string {
  const actual = packContentHash(pack)
  if (pack.packHash !== null && pack.packHash !== actual) {
    throw ApiError.badRequest('packHash does not match pack content', 'PACK_INVALID')
  }
  return actual
}

function distinctCurrentCents(card: AdjudicationCard): Set<number> {
  const values = new Set<number>()
  for (const price of card.priceCandidates) {
    if (price.currency === 'BRL' && price.kind === 'current') values.add(price.cents)
  }
  return values
}

/**
 * Converte a resposta compacta do modelo em decisoes validadas contra o pack.
 * Cards sem entrada valida viram `invalid_model_output`.
 */
export function parseModelOutput(text: string, pack: AdjudicationPack): ModelOutputParse {
  const parsed = safeParseJsonObject(text)
  const items = parsed && Array.isArray(parsed['d']) ? parsed['d'] : null

  // O modelo responde pelo NUMERO do card (1-based), nao pelo cardId.
  const byCardNumber = new Map<number, Record<string, unknown>>()
  if (items) {
    for (let index = 0; index < items.length; index += 1) {
      const item = readArrayItem(items, index)
      if (!item) continue
      const cardNumber = toFiniteNumber(item['c'])
      if (cardNumber === null || !Number.isInteger(cardNumber)) continue
      if (cardNumber < 1 || cardNumber > pack.cards.length) continue
      if (byCardNumber.has(cardNumber)) continue
      byCardNumber.set(cardNumber, item)
    }
  }

  const decisions: AdjudicationDecision[] = []
  const rejected: AdjudicationRejection[] = []
  let validationFailures = 0

  pack.cards.forEach((card, cardIndex) => {
    const item = byCardNumber.get(cardIndex + 1)
    if (!item) {
      rejected.push(reject(card.cardId, 'invalid_model_output'))
      validationFailures += 1
      return
    }

    const flag = toFiniteNumber(item['p'])
    if (flag === null) {
      rejected.push(reject(card.cardId, 'invalid_model_output'))
      validationFailures += 1
      return
    }

    if (flag !== 0 && flag !== 1) {
      rejected.push(reject(card.cardId, 'invalid_model_output'))
      validationFailures += 1
      return
    }

    if (flag === 0) {
      rejected.push(reject(card.cardId, 'not_a_product'))
      return
    }

    const titleLetter = toNonEmptyString(item['t'])
    const priceLetter = toNonEmptyString(item['pr'])
    const originalLetter = toNonEmptyString(item['o'])
    const imageLetter = toNonEmptyString(item['i'])
    const rawConfidence = toFiniteNumber(item['cf'])

    if (titleLetter === null || titleLetter === NONE_LETTER) {
      rejected.push(reject(card.cardId, 'missing_title'))
      return
    }
    if (priceLetter === null || priceLetter === NONE_LETTER) {
      rejected.push(reject(card.cardId, 'missing_price'))
      return
    }
    if (imageLetter === null || imageLetter === NONE_LETTER) {
      rejected.push(reject(card.cardId, 'missing_image'))
      return
    }
    if (rawConfidence === null) {
      rejected.push(reject(card.cardId, 'invalid_model_output'))
      validationFailures += 1
      return
    }

    const title = card.titleCandidates[indexForLetter(titleLetter)] ?? null
    const price = card.priceCandidates[indexForLetter(priceLetter)] ?? null
    const image = card.imageCandidates[indexForLetter(imageLetter)] ?? null
    if (!title || !price || !image) {
      rejected.push(reject(card.cardId, 'invalid_model_output'))
      validationFailures += 1
      return
    }

    if (price.kind !== 'current') {
      rejected.push(reject(card.cardId, 'invalid_model_output'))
      validationFailures += 1
      return
    }
    if (price.currency !== 'BRL') {
      rejected.push(reject(card.cardId, 'currency_mismatch'))
      return
    }
    if (distinctCurrentCents(card).size > 1) {
      rejected.push(reject(card.cardId, 'ambiguous_price'))
      return
    }

    let originalPriceId: string | null = null
    if (originalLetter !== null && originalLetter !== NONE_LETTER) {
      const original = card.priceCandidates[indexForLetter(originalLetter)] ?? null
      if (original && original.currency === 'BRL' && original.cents > price.cents) {
        originalPriceId = original.id
      }
    }

    decisions.push({
      cardId: card.cardId,
      source: 'model',
      isProduct: true,
      titleId: title.id,
      priceId: price.id,
      originalPriceId,
      imageId: image.id,
      confidence: Math.min(1, Math.max(0, rawConfidence / 100)),
      needsReview: false,
      reviewReasons: [],
    })
  })

  return { decisions, rejected, validationFailures }
}

export interface TitleDecision {
  cardId: string
  /** false = modelo afirmou nao-produto; null = absteve/saida invalida. */
  isProduct: boolean | null
  titleId: string | null
  confidence: number
}

/**
 * Parser reduzido usado no fluxo hibrido: o modelo so decide produto + titulo.
 * Preco/imagem do mini-pack sao ignorados (a heuristica ja os resolveu).
 */
export function parseTitleDecisions(
  text: string,
  pack: AdjudicationPack,
): Map<string, TitleDecision> {
  const result = new Map<string, TitleDecision>()
  const parsed = safeParseJsonObject(text)
  const items = parsed && Array.isArray(parsed['d']) ? parsed['d'] : null
  if (!items) return result

  for (let index = 0; index < items.length; index += 1) {
    const item = readArrayItem(items, index)
    if (!item) continue
    const cardNumber = toFiniteNumber(item['c'])
    if (cardNumber === null || !Number.isInteger(cardNumber)) continue
    if (cardNumber < 1 || cardNumber > pack.cards.length) continue
    const card = pack.cards[cardNumber - 1]
    if (!card || result.has(card.cardId)) continue

    const flag = toFiniteNumber(item['p'])
    if (flag === null) continue
    if (flag !== 0 && flag !== 1) {
      // Fora de 0/1 nao e afirmacao valida: abstenção.
      result.set(card.cardId, { cardId: card.cardId, isProduct: null, titleId: null, confidence: 0 })
      continue
    }
    if (flag === 0) {
      const rawConfidence = toFiniteNumber(item['cf'])
      result.set(card.cardId, {
        cardId: card.cardId,
        isProduct: false,
        titleId: null,
        confidence:
          rawConfidence === null ? 0.5 : Math.min(1, Math.max(0, rawConfidence / 100)),
      })
      continue
    }

    const titleLetter = toNonEmptyString(item['t'])
    if (titleLetter === null || titleLetter === NONE_LETTER) {
      // p=1 sem titulo valido = abstenção, NAO "nao e produto".
      result.set(card.cardId, { cardId: card.cardId, isProduct: null, titleId: null, confidence: 0 })
      continue
    }

    const title = card.titleCandidates[indexForLetter(titleLetter)] ?? null
    if (!title) continue

    const rawConfidence = toFiniteNumber(item['cf'])
    result.set(card.cardId, {
      cardId: card.cardId,
      isProduct: true,
      titleId: title.id,
      confidence:
        rawConfidence === null ? 0.5 : Math.min(1, Math.max(0, rawConfidence / 100)),
    })
  }

  return result
}
