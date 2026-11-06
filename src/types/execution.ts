import type { AdjMode } from '../config/env.ts'

export interface ExecutionOptions {
  mode?: AdjMode
  model?: string
  cache?: boolean | 'refresh'
  requestId?: string
}

export interface ExecutionRequest {
  profile?: string
  input: unknown
  options?: ExecutionOptions
}

export type ExecutionMode = 'llm' | 'heuristic' | 'fake' | 'fallback'

export interface ExecutionValidation {
  ok: boolean
  errors: string[]
  evidenceCount: number
}

export interface ExecutionResult {
  profileId: string
  profileVersion: string
  promptHash: string
  modelId: string
  modelVersion: string
  provider: string
  mode: ExecutionMode
  cache: {
    appHit: boolean
    providerCachedTokens: number
  }
  validation: ExecutionValidation
  output: Record<string, unknown> | null
  fallbackReason: string | null
  latencyMs: number
}
