import type {
  AdjudicationCard,
  AdjudicationPack,
  ImageCandidate,
  PriceCandidate,
  TitleCandidate,
} from '../src/types/adjudication.ts'

export interface CardOptions {
  title?: string
  prices?: PriceCandidate[]
  images?: ImageCandidate[]
  titles?: TitleCandidate[]
}

export function makeCard(cardId = 'c1', options: CardOptions = {}): AdjudicationCard {
  return {
    cardId,
    host: 'amazon.com.br',
    titleCandidates: options.titles ?? [
      { id: `t_${cardId}`, text: options.title ?? 'Fone Bluetooth XYZ com cancelamento de ruido' },
    ],
    priceCandidates: options.prices ?? [
      { id: `p_${cardId}`, text: 'R$ 199,90', currency: 'BRL', cents: 19990, kind: 'current' },
      { id: `o_${cardId}`, text: 'R$ 249,90', currency: 'BRL', cents: 24990, kind: 'original' },
    ],
    imageCandidates: options.images ?? [
      { id: `i_${cardId}`, url: 'https://m.media-amazon.com/images/I/example.jpg' },
    ],
    context: { position: 1, breadcrumb: null },
  }
}

export function makePack(cards: AdjudicationCard[], marketplace = 'amazon'): AdjudicationPack {
  return { packVersion: '1', marketplace, packHash: null, cards }
}
