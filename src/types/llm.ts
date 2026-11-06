// ============================================================================
// Tipos GERAIS dos providers de LLM. Ficam em src/types para que modulos,
// providers e testes compartilhem o mesmo contrato (sem acoplamento ao SDK).
// ============================================================================

export type LlmProviderName = 'fake' | 'llamacpp' | 'http'

export interface ModelConfig {
  id: string
  provider: LlmProviderName
  version: string
}

export interface CompletionMetadata {
  profileId?: string
  profileMode?: string
  /** Apenas para testes determinísticos do pipeline genérico. */
  fakeOutput?: unknown
}

export interface CompletionInput {
  system: string
  user: string
  grammar: string | null
  maxTokens: number
  temperature: number
  timeoutMs: number
  signal: AbortSignal | null
  /** Metadados estruturados; o fake usa isto em vez de parsear o prompt. */
  metadata?: CompletionMetadata
  /** JSON Schema de saída, quando o provider suportar. */
  responseSchema?: Record<string, unknown> | null
  promptCacheKey?: string
  promptCacheTtl?: string
}

export interface CompletionResult {
  text: string
  tokensIn: number
  tokensOut: number
  latencyMs: number
  cachedTokens?: number
  cacheWriteTokens?: number
  finishReason?: string | null
}

export interface LlmProvider {
  readonly name: LlmProviderName
  readonly modelId: string
  readonly modelVersion: string
  load(): Promise<void>
  isReady(): Promise<boolean>
  complete(input: CompletionInput): Promise<CompletionResult>
  dispose(): Promise<void>
}
