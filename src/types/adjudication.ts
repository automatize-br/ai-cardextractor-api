// ============================================================================
// Contrato de adjudicacao. Todos os campos sao OBRIGATORIOS (null explicito)
// para evitar divergencia entre zod, JSON e TypeScript com
// `exactOptionalPropertyTypes`.
//
// Principio: a IA devolve apenas IDs de candidatos que JA existem no pack.
// Nenhum valor (titulo, preco, link, imagem) e gerado pelo modelo.
// ============================================================================

export type PriceKind = 'current' | 'original' | 'installment' | 'unknown'

export interface TitleCandidate {
  id: string
  text: string
}

export interface PriceCandidate {
  id: string
  text: string
  currency: string
  cents: number
  kind: PriceKind
}

export interface ImageCandidate {
  id: string
  url: string
}

export interface CardContext {
  position: number | null
  breadcrumb: string | null
}

export interface AdjudicationCard {
  cardId: string
  host: string
  titleCandidates: TitleCandidate[]
  priceCandidates: PriceCandidate[]
  imageCandidates: ImageCandidate[]
  context: CardContext
}

export interface AdjudicationPack {
  packVersion: string
  marketplace: string
  packHash: string | null
  cards: AdjudicationCard[]
}

export interface AdjudicationDecision {
  cardId: string
  isProduct: boolean
  titleId: string | null
  priceId: string | null
  originalPriceId: string | null
  imageId: string | null
  confidence: number
}

export type RejectionReason =
  | 'not_a_product'
  | 'missing_title'
  | 'missing_price'
  | 'missing_image'
  | 'currency_mismatch'
  | 'ambiguous_price'
  | 'invalid_model_output'

export interface AdjudicationRejection {
  cardId: string
  reason: RejectionReason
}

export type AdjudicationMode = 'llm' | 'fake' | 'fallback'

export interface AdjudicationResult {
  packVersion: string
  packHash: string
  mode: AdjudicationMode
  modelId: string | null
  modelVersion: string | null
  promptVersion: string
  latencyMs: number
  fallbackReason: string | null
  decisions: AdjudicationDecision[]
  rejected: AdjudicationRejection[]
}

export interface AdjudicationStats {
  day: string
  total: number
  llm: number
  fallback: number
  avgLatencyMs: number
  validationFailures: number
}
