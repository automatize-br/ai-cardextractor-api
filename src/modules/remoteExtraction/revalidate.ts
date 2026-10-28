import { parse } from 'node-html-parser'
import { isMarketplaceHost } from '../../config/marketplaces.ts'
import type { ExtractedCard } from '../extraction/types.ts'

// ============================================================================
// Revalidação dos cards DENTRO do extractor (contrato v2).
//
// Antes a API revalidava com o HTML que ela mesma buscava. Agora o HTML nunca
// sai do extractor: ele faz grounding (quotes no documento), valida preço/
// moeda/imagem/permalink e devolve ofertas já no formato que a API consome.
// ============================================================================

export interface RemoteOffer {
  externalProductId: string | null
  title: string
  price: number
  originalPrice: number | null
  currency: string
  image: string | null
  permalink: string
  extra: string | null
  candidates: {
    titles: string[]
    prices: Array<{ cents: number; currency: string; kind: 'current' | 'original' | 'unknown'; text: string }>
    images: string[]
  }
  needsReview?: boolean
  reviewReasons?: string[]
  extractionSource: 'pool'
}

export interface DiscardedCounters {
  missingTitle: number
  missingPrice: number
  missingImage: number
  invalidLink: number
  notAProduct: number
  ambiguousPrice: number
  currency: number
  irrelevant: number
}

export interface Revalidation {
  offers: RemoteOffer[]
  discarded: DiscardedCounters
  rejected: number
}

export function emptyDiscarded(): DiscardedCounters {
  return {
    missingTitle: 0,
    missingPrice: 0,
    missingImage: 0,
    invalidLink: 0,
    notAProduct: 0,
    ambiguousPrice: 0,
    currency: 0,
    irrelevant: 0,
  }
}

function httpUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function normalizedText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().toLowerCase()
}

function evidenceReasons(card: ExtractedCard, root: ReturnType<typeof parse>): string[] {
  const reasons: string[] = []
  const documentText = normalizedText(root.textContent ?? '')
  const titleQuote = normalizedText(card.evidence?.title?.quote ?? '')
  if (titleQuote !== '' && !documentText.includes(titleQuote)) reasons.push('evidence_title_mismatch')
  const priceQuote = normalizedText(card.evidence?.price?.quote ?? '')
  if (priceQuote !== '' && !documentText.includes(priceQuote)) reasons.push('evidence_price_mismatch')
  return reasons
}

/** Converte/valida os cards extraídos para o contrato `RawOffer` da API. */
export function revalidateCards(cards: ExtractedCard[], html: string, marketplace: string): Revalidation {
  const discarded = emptyDiscarded()
  const offers: RemoteOffer[] = []
  const root = html.trim() === '' ? null : parse(html)
  let rejected = 0

  for (const card of cards) {
    const title = (card.title ?? '').trim()
    if (title === '') {
      discarded.missingTitle += 1
      rejected += 1
      continue
    }
    const price = card.priceCents
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || !Number.isInteger(price)) {
      discarded.missingPrice += 1
      rejected += 1
      continue
    }
    const permalinkUrl = httpUrl(card.permalink)
    if (!permalinkUrl || !isMarketplaceHost(marketplace, permalinkUrl.hostname)) {
      discarded.invalidLink += 1
      rejected += 1
      continue
    }
    if (!httpUrl(card.imageUrl)) {
      discarded.missingImage += 1
      rejected += 1
      continue
    }
    const currency = (card.currency ?? '').toUpperCase()
    if (currency !== 'BRL') {
      discarded.currency += 1
      rejected += 1
      continue
    }

    const originalRaw = card.originalPriceCents ?? null
    const original = originalRaw !== null && Number.isInteger(originalRaw) && originalRaw > price ? originalRaw : null
    const reasons = new Set<string>(card.reviewReasons ?? [])
    if (originalRaw !== null && original === null) reasons.add('original_price_invalid')
    if (card.needsReview === true) reasons.add('extractor_needs_review')

    if (typeof card.externalProductId === 'string' && card.externalProductId !== '') {
      if (!card.permalink.includes(card.externalProductId)) reasons.add('external_id_mismatch')
    }
    if (root) {
      for (const reason of evidenceReasons(card, root)) reasons.add(reason)
    }

    const priceCandidates = card.candidates?.prices ?? []
    const currentCandidate = priceCandidates.find((candidate) => candidate.kind === 'current' && candidate.cents === price)
    if (priceCandidates.length > 0 && !currentCandidate) reasons.add('price_not_in_candidates')

    offers.push({
      externalProductId: card.externalProductId ?? null,
      title: title.slice(0, 300),
      price,
      originalPrice: original,
      currency,
      image: card.imageUrl ?? null,
      permalink: permalinkUrl.toString(),
      extra: null,
      candidates: {
        titles: (card.candidates?.titles ?? [{ id: 't1', text: title }]).slice(0, 20).map((item) => item.text),
        prices: (priceCandidates.length > 0 ? priceCandidates : [{ cents: price, currency, kind: 'current', text: '' }])
          .slice(0, 20)
          .filter((item) => Number.isInteger(item.cents) && item.cents > 0)
          .map((item) => ({
            cents: item.cents,
            currency: (item.currency || currency).toUpperCase().slice(0, 3),
            kind: item.kind === 'current' || item.kind === 'original' ? item.kind : 'unknown',
            text: item.text,
          })),
        images: (card.candidates?.images ?? [{ id: 'i1', url: card.imageUrl ?? '' }])
          .slice(0, 20)
          .map((item) => item.url),
      },
      ...(reasons.size > 0 ? { needsReview: true, reviewReasons: [...reasons] } : {}),
      extractionSource: 'pool',
    })
  }

  return { offers, discarded, rejected }
}
