// ============================================================================
// Perfil de tarefa (v2): tudo que varia por extração/qualificação vem do .env.
// O perfil é validado no boot e o hash entra na cacheKey.
// ============================================================================

import type { StructuredOutputMode } from './model.ts'

export type JsonSchema = Record<string, unknown>

export type ProfileMode = 'selection' | 'extraction' | 'classification' | 'score'

export type GroundingMode = 'none' | 'candidate_ids' | 'source_quotes'

export type CoverageMode = 'exact' | 'partial'

export type FallbackPolicy = 'heuristic' | 'review' | 'reject'

export interface PromptExample {
  input: unknown
  output: unknown
}

export interface RuleConfig {
  type: string
  field?: string
  collection?: string
  filter?: Record<string, unknown>
  name?: string
  params?: Record<string, unknown>
}

export interface TaskProfileModel {
  id: string
  allowedModels: string[]
  temperature: number
  maxTokens: number | null
  timeoutMs: number | null
  batchSize: number | null
  structuredOutput: StructuredOutputMode | null
}

export interface TaskProfileCache {
  appTtlMs: number | null
  promptPrefix: boolean
  storeQuotes: boolean
  maxPromptCacheBlocks: number
}

export interface TaskProfile {
  id: string
  version: string
  description: string | null
  mode: ProfileMode
  input: {
    schema: JsonSchema
    /** Nome da coleção de itens no input (default "items"; cards usa "cards"). */
    collection: string
    maxItems: number | null
    maxChars: number | null
  }
  output: {
    schema: JsonSchema
  }
  prompt: {
    system: string
    rules: string[]
    examples: PromptExample[]
    userTemplate: string | null
  }
  validation: {
    grounding: GroundingMode
    coverage: CoverageMode
    candidateFields: Record<string, string>
    rules: RuleConfig[]
    fallback: FallbackPolicy
    minConfidence: number
  }
  rulesVersion: string
  model: TaskProfileModel
  cache: TaskProfileCache
}

export interface RegisteredProfile {
  profile: TaskProfile
  profileHash: string
  promptHash: string
  schemaHash: string
}

export interface ProfileSummary {
  id: string
  version: string
  description: string | null
  mode: ProfileMode
  profileHash: string
  promptHash: string
  modelId: string
}
