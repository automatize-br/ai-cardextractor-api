// ============================================================================
// Catálogo de modelos (v2). Independente do provider legado (`LlmProvider`):
// aqui ficam apenas os metadados declarativos lidos do .env.
// ============================================================================

export type CatalogProvider =
  | 'fake'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openai-compatible'

export type StructuredOutputMode = 'json_schema' | 'tool' | 'grammar' | 'json_object' | 'none'

export type PromptCachingMode = 'auto' | 'explicit' | 'off'

export interface ModelCost {
  inputPerM: number
  outputPerM: number
}

export interface CatalogModel {
  id: string
  version: string
  provider: CatalogProvider
  model: string
  baseUrl: string
  apiKeyEnv: string
  structuredOutput: StructuredOutputMode
  promptCaching: PromptCachingMode
  maxContext: number
  maxOutput: number
  cost: ModelCost | null
}

export interface RegisteredModel extends CatalogModel {
  /** Hash canônico do modelo; entra na cacheKey. */
  modelHash: string
}
