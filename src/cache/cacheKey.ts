import { env } from '../config/env.ts'
import { computeHash } from '../helpers/packHash.ts'
import type { RegisteredModel } from '../types/model.ts'
import type { RegisteredProfile, TaskProfile } from '../types/profile.ts'

// ============================================================================
// Chave determinística do cache de aplicação. Qualquer mudança de modo,
// versão, regra, prompt, modelo ou input invalida naturalmente.
// ============================================================================

export interface CacheKeyInput {
  profile: RegisteredProfile
  model: RegisteredModel
  mode: string
  input: unknown
  batchSize: number
}

export function executionCacheKey({ profile, model, mode, input, batchSize }: CacheKeyInput): string {
  const task = profile.profile
  return computeHash({
    configVersion: env.AI_CONFIG_VERSION,
    engineVersion: env.AI_ENGINE_VERSION,
    profileId: task.id,
    profileVersion: task.version,
    profileHash: profile.profileHash,
    promptHash: profile.promptHash,
    rulesVersion: task.rulesVersion,
    modelId: model.id,
    modelVersion: model.version,
    modelHash: model.modelHash,
    provider: model.provider,
    structuredOutput: model.structuredOutput,
    mode,
    minConfidence: task.validation.minConfidence,
    fallbackPolicy: task.validation.fallback,
    temperature: task.model.temperature,
    topP: env.AI_TOP_P,
    seed: env.AI_SEED,
    maxTokens: task.model.maxTokens,
    batchSize,
    input,
  })
}

export function profileCacheEnabled(profile: TaskProfile): boolean {
  if (env.AI_APP_CACHE === 'off') return false
  if (profile.mode === 'extraction' && !env.AI_APP_CACHE_STORE_QUOTES) return false
  return true
}
