export const PROMPT_VERSION = '1'
export const PACK_VERSION = '1'

export const PRICE_KINDS = ['current', 'original', 'installment', 'unknown'] as const
export type PriceKindName = (typeof PRICE_KINDS)[number]

export const REJECTION_REASONS = [
  'not_a_product',
  'missing_title',
  'missing_price',
  'missing_image',
  'currency_mismatch',
  'ambiguous_price',
  'invalid_model_output',
] as const
export type RejectionReasonName = (typeof REJECTION_REASONS)[number]

export const ADJUDICATION_MODE = {
  LLM: 'llm',
  FAKE: 'fake',
  FALLBACK: 'fallback',
} as const

export const MAX_CONFIDENCE = 1
export const MIN_CONFIDENCE = 0
