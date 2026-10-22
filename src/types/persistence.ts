import type { AdjudicationMode, AdjudicationStats } from './adjudication.ts'

export interface AdjudicationRecord {
  adjudicationId: string
  packHash: string
  packVersion: string
  marketplace: string
  mode: AdjudicationMode
  modelId: string | null
  modelVersion: string | null
  promptVersion: string
  latencyMs: number
  cards: number
  decisions: number
  rejected: number
  validationFailures: number
  fallbackReason: string | null
  modelCalls: number
  /** Escolhas do modelo em modo shadow (evidencia), sem aplicar na resposta. */
  shadow: Array<{
    cardId: string
    isProduct: boolean | null
    titleId: string | null
    confidence: number
  }> | null
  createdAt: Date
  pack: unknown | null
}

export interface Persistence {
  readonly name: 'memory' | 'mongo'
  save(record: AdjudicationRecord): Promise<void>
  stats(day: string): Promise<AdjudicationStats>
  close(): Promise<void>
}
