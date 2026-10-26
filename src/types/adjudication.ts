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

export type DecisionSource = 'heuristic' | 'model'

export interface AdjudicationDecision {
  cardId: string
  /** Quem decidiu: regras deterministicas ou o modelo. */
  source: DecisionSource
  isProduct: boolean
  titleId: string | null
  priceId: string | null
  originalPriceId: string | null
  imageId: string | null
  confidence: number
  /** Oferta completa, mas incerta: enviar para revisao em vez de descartar. */
  needsReview: boolean
  reviewReasons: ReviewReason[]
}

export type RejectionReason =
  | 'not_a_product'
  | 'missing_title'
  | 'missing_price'
  | 'missing_image'
  | 'currency_mismatch'
  | 'ambiguous_price'
  | 'invalid_model_output'
  | 'model_fallback'

export interface AdjudicationRejection {
  cardId: string
  reason: RejectionReason
}

export type AdjudicationMode = 'llm' | 'heuristic' | 'fake' | 'fallback'

export type ReviewReason = 'low_confidence' | 'ambiguous_title' | 'model_fallback'

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
  heuristic: number
  fallback: number
  modelCalls: number
  avgLatencyMs: number
  validationFailures: number
}
