// ============================================================================
// Replay de adjudicação (F6). É a matéria-prima do dataset: pack + decisão
// final + escolha shadow do modelo. Só é gravado quando AI_REPLAY_PATH está
// configurado (opt-in) e o modo não é `off`.
// ============================================================================

import type {
  AdjudicationDecision,
  AdjudicationMode,
  AdjudicationPack,
  AdjudicationRejection,
} from './adjudication.ts'

export interface ReplayShadowChoice {
  cardId: string
  isProduct: boolean | null
  titleId: string | null
  confidence: number
}

export interface ReplayRecord {
  capturedAt: string
  packHash: string
  packVersion: string
  marketplace: string
  mode: AdjudicationMode
  modelId: string | null
  modelVersion: string | null
  promptVersion: string
  latencyMs: number
  /** Presente em replays novos; ausente em arquivos antigos. */
  fallbackReason?: string | null
  pack: AdjudicationPack | null
  decisions: AdjudicationDecision[]
  rejected: AdjudicationRejection[]
  shadow: ReplayShadowChoice[] | null
}
