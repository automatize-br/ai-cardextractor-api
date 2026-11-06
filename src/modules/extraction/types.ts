import type { ExecutionResult } from '../../types/execution.ts'

export interface ExtractionCandidateSet {
  titles: Array<{ id: string; text: string }>
  prices: Array<{ id: string; cents: number; currency: string; kind: 'current' | 'original' | 'unknown'; text: string }>
  images: Array<{ id: string; url: string }>
}

export interface ExtractedCard {
  cardId: string
  externalProductId: string | null
  permalink: string
  title: string
  priceCents: number
  currency: string
  originalPriceCents: number | null
  imageUrl: string
  candidates: ExtractionCandidateSet
  evidence: {
    cardRoot: { selector: string; occurrence: number }
    title: { source: 'jsonld' | 'dom'; quote: string; pointer?: string; selector?: string }
    price: { source: 'jsonld' | 'dom'; quote: string; pointer?: string; selector?: string }
    image: { source: 'jsonld' | 'dom'; quote: string; pointer?: string; selector?: string }
  }
  confidence: number
  needsReview: boolean
  reviewReasons: string[]
}

export interface ExtractionResult {
  marketplace: string
  cards: ExtractedCard[]
  rejected: Array<{ cardId: string; reason: string }>
  scanned: number
  truncated: boolean
  coverageComplete: boolean
  quality: 'ok' | 'no_cards' | 'all_rejected' | 'html_too_large_after_trim' | 'partial'
  mode: string
  execution: ExecutionResult | null
}
