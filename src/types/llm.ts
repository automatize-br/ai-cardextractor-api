// ============================================================================
// Tipos GERAIS dos providers de LLM. Ficam em src/types para que modulos,
// providers e testes compartilhem o mesmo contrato (sem acoplamento ao SDK).
// ============================================================================

export type LlmProviderName = 'fake' | 'llamacpp' | 'http'

export interface ModelConfig {
  id: string
  provider: LlmProviderName
  path: string
  contextSize: number
  version: string
}

export interface CompletionInput {
  system: string
  user: string
  grammar: string | null
  maxTokens: number
  temperature: number
  timeoutMs: number
  signal: AbortSignal | null
}

export interface CompletionResult {
  text: string
  tokensIn: number
  tokensOut: number
  latencyMs: number
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
