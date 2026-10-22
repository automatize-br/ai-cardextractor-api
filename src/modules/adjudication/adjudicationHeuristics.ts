import type {
  AdjudicationCard,
  AdjudicationDecision,
  AdjudicationRejection,
  PriceCandidate,
  RejectionReason,
} from '../../types/adjudication.ts'

// ============================================================================
// Pre-selecao deterministica (hibrida).
//
// O modelo 0.5B nao lida bem com "responda N itens" e erra banners. Entao o
// servidor resolve TUDO que e objetivo (preco atual unico em BRL, original,
// imagem, titulo unico) e chama o modelo APENAS para escolher o titulo quando
// ha mais de um candidato plausivel (ex.: variacoes do mesmo anuncio).
//
// Preco/imagem/original escolhidos aqui NUNCA sao sobrescritos pelo modelo.
// ============================================================================

// Rotulos de UI que aparecem como "titulo" de card. A comparacao e por titulo
// INTEIRO (ou prefixo de rotulo seguido de separador), nunca por substring:
// "Tenis com cupom 20%" e "Porta-cupom de mesa" sao produtos legitimos.
const NOISE_TITLE_LABELS = [
  'patrocinado',
  'patrocinada',
  'publicidade',
  'anuncio',
  'sponsored',
  'advertisement',
  'frete gratis',
  'avaliacoes',
  'ver mais',
  'resultados',
  'recomendado para voce',
]

// Prefixos que sozinhos ja identificam rotulo (ex.: "Patrocinado · Loja X").
const NOISE_TITLE_PREFIXES = ['patrocinado', 'patrocinada', 'publicidade', 'anuncio', 'sponsored']

export interface PendingCard {
  cardId: string
  titleIds: string[]
  priceId: string
  imageId: string
  originalPriceId: string | null
  /** Card reduzido enviado ao modelo (1 preco, 1 imagem, titulos plausiveis). */
  miniCard: AdjudicationCard
}

export interface HeuristicOutcome {
  decisions: AdjudicationDecision[]
  rejected: AdjudicationRejection[]
  pending: PendingCard[]
}

function reject(cardId: string, reason: RejectionReason): AdjudicationRejection {
  return { cardId, reason }
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isNoiseTitle(text: string): boolean {
  const value = normalize(text)
  if (value === '') return true
  if (NOISE_TITLE_LABELS.includes(value)) return true
  return NOISE_TITLE_PREFIXES.some(
    (prefix) => value === prefix || value.startsWith(`${prefix} `) || value.startsWith(`${prefix}:`),
  )
}

function currentBrlCandidates(card: AdjudicationCard): PriceCandidate[] {
  return card.priceCandidates.filter(
    (price) => price.currency === 'BRL' && price.kind === 'current',
  )
}

function pickPrice(card: AdjudicationCard): PriceCandidate | RejectionReason {
  const currents = currentBrlCandidates(card)
  if (currents.length === 0) {
    const hasOtherCurrent = card.priceCandidates.some((price) => price.kind === 'current')
    return hasOtherCurrent ? 'currency_mismatch' : 'missing_price'
  }
  const distinct = new Set(currents.map((price) => price.cents))
  if (distinct.size > 1) return 'ambiguous_price'

  const price = currents[0]
  if (!price) return 'missing_price'
  if (price.cents <= 0) return 'missing_price'
  return price
}

function pickOriginal(card: AdjudicationCard, price: PriceCandidate): string | null {
  const originals = card.priceCandidates
    .filter(
      (candidate) =>
        candidate.kind === 'original' && candidate.currency === 'BRL' && candidate.cents > price.cents,
    )
    .sort((a, b) => b.cents - a.cents)
  return originals[0]?.id ?? null
}

export function longestTitleId(pending: PendingCard): string | null {
  const titles = pending.miniCard.titleCandidates
  if (titles.length === 0) return null
  return [...titles].sort((a, b) => b.text.length - a.text.length)[0]?.id ?? null
}

export function adjudicateDeterministically(
  cards: AdjudicationCard[],
  confidence = 0.95,
): HeuristicOutcome {
  const decisions: AdjudicationDecision[] = []
  const rejected: AdjudicationRejection[] = []
  const pending: PendingCard[] = []

  for (const card of cards) {
    const price = pickPrice(card)
    if (typeof price === 'string') {
      rejected.push(reject(card.cardId, price))
      continue
    }

    const image = card.imageCandidates[0]
    if (!image) {
      rejected.push(reject(card.cardId, 'missing_image'))
      continue
    }

    if (card.titleCandidates.length === 0) {
      rejected.push(reject(card.cardId, 'missing_title'))
      continue
    }

    const plausible = card.titleCandidates.filter((title) => !isNoiseTitle(title.text))
    if (plausible.length === 0) {
      // Todos os titulos sao rotulos de UI (banner/anuncio), nao produto.
      rejected.push(reject(card.cardId, 'not_a_product'))
      continue
    }

    const originalPriceId = pickOriginal(card, price)

    if (plausible.length === 1) {
      const title = plausible[0]
      if (!title) {
        rejected.push(reject(card.cardId, 'missing_title'))
        continue
      }
      decisions.push({
        cardId: card.cardId,
        source: 'heuristic',
        isProduct: true,
        titleId: title.id,
        priceId: price.id,
        originalPriceId,
        imageId: image.id,
        confidence,
        needsReview: false,
        reviewReasons: [],
      })
      continue
    }

    pending.push({
      cardId: card.cardId,
      titleIds: plausible.map((title) => title.id),
      priceId: price.id,
      imageId: image.id,
      originalPriceId,
      miniCard: {
        cardId: card.cardId,
        host: card.host,
        titleCandidates: plausible,
        priceCandidates: [price],
        imageCandidates: [image],
        context: card.context,
      },
    })
  }

  return { decisions, rejected, pending }
}
