import { z } from 'zod'
import { appCache } from '../../cache/appCache.ts'
import { executionCacheKey, profileCacheEnabled } from '../../cache/cacheKey.ts'
import { env, getMode } from '../../config/env.ts'
import { getModel } from '../../config/models.ts'
import { getDefaultProfile, getProfile } from '../../config/profiles.ts'
import { validateJson } from '../../config/schema.ts'
import { ApiError } from '../../exceptions/ApiError.ts'
import { getCatalogProvider } from '../../providers/llm/catalogProvider.ts'
import type { ExecutionMode, ExecutionRequest, ExecutionResult } from '../../types/execution.ts'
import { buildPrompt } from './promptBuilder.ts'
import { validateOutput } from './outputValidator.ts'

// ============================================================================
// Executor genérico v2: perfis configurados no .env, provider
// fake/openai-compatible, validação de schema/cobertura/referências/evidência,
// cache de aplicação com single-flight.
// ============================================================================

const optionsSchema = z
  .object({
    mode: z.enum(['off', 'shadow', 'assist', 'on']).optional(),
    model: z.string().trim().min(1).max(64).optional(),
    cache: z.union([z.boolean(), z.literal('refresh')]).optional(),
    requestId: z.string().trim().max(200).optional(),
  })
  .strict()

const requestSchema = z
  .object({
    profile: z.string().trim().min(1).max(64).optional(),
    input: z.unknown(),
    options: optionsSchema.optional(),
  })
  .strict()

function parseRequest(raw: unknown): ExecutionRequest {
  const parsed = requestSchema.safeParse(raw)
  if (!parsed.success) {
    throw ApiError.inputInvalid(
      'Invalid execution request',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    )
  }
  const value = parsed.data
  const options = value.options
  const normalizedOptions =
    options === undefined
      ? undefined
      : {
          ...(options.mode !== undefined ? { mode: options.mode } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
          ...(options.cache !== undefined ? { cache: options.cache } : {}),
          ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
        }
  return {
    ...(value.profile !== undefined ? { profile: value.profile } : {}),
    input: value.input,
    ...(normalizedOptions !== undefined ? { options: normalizedOptions } : {}),
  }
}

function checkLimits(profile: ReturnType<typeof getProfile>, input: unknown): void {
  if (!profile) return
  const maxChars = profile.profile.input.maxChars ?? env.AI_MAX_INPUT_CHARS
  const serialized = JSON.stringify(input)
  if (serialized.length > maxChars) {
    throw new ApiError(413, 'PACK_TOO_LARGE', `Input exceeds ${maxChars} chars`)
  }
  const maxItems = profile.profile.input.maxItems ?? env.AI_MAX_ITEMS
  const collection = profile.profile.input.collection
  if (typeof input === 'object' && input !== null && Array.isArray((input as Record<string, unknown>)[collection])) {
    const count = ((input as Record<string, unknown>)[collection] as unknown[]).length
    if (count > maxItems) {
      throw new ApiError(413, 'PACK_TOO_LARGE', `Input exceeds ${maxItems} items`, { items: count, limit: maxItems })
    }
  }
}

const pendingExecutions = new Map<string, Promise<ExecutionResult>>()

function fallbackResult(
  profile: NonNullable<ReturnType<typeof getProfile>>,
  modelId: string,
  modelVersion: string,
  provider: string,
  started: number,
  reason: string,
  validationErrors: string[],
): ExecutionResult {
  return {
    profileId: profile.profile.id,
    profileVersion: profile.profile.version,
    promptHash: profile.promptHash,
    modelId,
    modelVersion,
    provider,
    mode: 'fallback',
    cache: { appHit: false, providerCachedTokens: 0 },
    validation: { ok: false, errors: validationErrors, evidenceCount: 0 },
    output: null,
    fallbackReason: reason,
    latencyMs: Date.now() - started,
  }
}

export default class ExecutionService {
  static async execute(
    raw: unknown,
    runtime: { signal?: AbortSignal | null } = {},
  ): Promise<ExecutionResult> {
    const started = Date.now()
    const request = parseRequest(raw)
    const registered = request.profile ? getProfile(request.profile) : getDefaultProfile()
    if (!registered) {
      throw ApiError.unknownProfile(request.profile ? `Unknown profile: ${request.profile}` : 'No profile configured')
    }

    const inputCheck = validateJson(
      registered.profile.input.schema,
      request.input,
      `profile "${registered.profile.id}" input.schema`,
    )
    if (!inputCheck.ok) {
      throw ApiError.inputInvalid('Input does not match profile schema', inputCheck.errors)
    }
    checkLimits(registered, request.input)

    const requestedModel = request.options?.model ?? registered.profile.model.id
    const allowed = registered.profile.model.allowedModels.length > 0
      ? registered.profile.model.allowedModels
      : [registered.profile.model.id]
    if (!allowed.includes(requestedModel)) {
      throw ApiError.inputInvalid(`Model "${requestedModel}" is not allowed for profile "${registered.profile.id}"`)
    }

    const model = getModel(requestedModel)
    if (!model) throw ApiError.profileMisconfigured(`Model "${requestedModel}" not found`)

    const mode = request.options?.mode ?? getMode()
    if (mode === 'off') throw ApiError.modelDisabled('AI_MODE=off')
    if (mode === 'shadow') {
      throw ApiError.modelDisabled('AI_MODE=shadow não é suportado no /v1/execute sem fallback determinístico')
    }

    const prompt = buildPrompt(registered.profile, request.input)
    const maxTokens =
      registered.profile.model.maxTokens ?? Math.min(env.AI_MAX_OUTPUT_TOKENS, model.maxOutput)
    const timeoutMs = registered.profile.model.timeoutMs ?? env.AI_TIMEOUT_MS
    const batchSize = registered.profile.model.batchSize ?? env.AI_BATCH_SIZE
    const promptCacheKey = `${registered.profile.id}:${registered.promptHash.slice(0, 16)}:${model.modelHash.slice(0, 16)}`

    const cacheEnabled = profileCacheEnabled(registered.profile) && request.options?.cache !== false
    const cacheKey = executionCacheKey({
      profile: registered,
      model,
      mode,
      input: request.input,
      batchSize,
    })
    if (cacheEnabled && request.options?.cache !== 'refresh') {
      const cached = appCache.get(cacheKey) as ExecutionResult | null
      if (cached) {
        return {
          ...cached,
          cache: { ...cached.cache, appHit: true },
          latencyMs: Date.now() - started,
        }
      }
    }

    const runModel = async (): Promise<ExecutionResult> => {
      try {
        const provider = getCatalogProvider(model)
        const completion = await provider.complete({
          system: prompt.system,
          user: prompt.user,
          outputSchema: registered.profile.output.schema,
          maxTokens,
          temperature: registered.profile.model.temperature,
          topP: env.AI_TOP_P,
          timeoutMs,
          signal: runtime.signal ?? AbortSignal.timeout(timeoutMs),
          promptCacheKey,
          promptCacheTtl: env.AI_PROMPT_CACHE_TTL,
        })

        const validation = validateOutput(registered.profile, request.input, completion.text)
        if (!validation.ok) {
          if (!env.AI_FAIL_OPEN) {
            throw new ApiError(503, 'AI_PROVIDER_ERROR', 'Model output failed validation', validation.errors)
          }
          return fallbackResult(
            registered,
            model.id,
            model.version,
            model.provider,
            started,
            'INVALID_MODEL_OUTPUT',
            validation.errors,
          )
        }

        const resultMode: ExecutionMode = model.provider === 'fake' ? 'fake' : 'llm'
        return {
          profileId: registered.profile.id,
          profileVersion: registered.profile.version,
          promptHash: registered.promptHash,
          modelId: model.id,
          modelVersion: model.version,
          provider: model.provider,
          mode: resultMode,
          cache: { appHit: false, providerCachedTokens: completion.cachedTokens },
          validation: {
            ok: true,
            errors: [],
            evidenceCount: validation.evidenceCount,
          },
          output: validation.value,
          fallbackReason: null,
          latencyMs: Date.now() - started,
        }
      } catch (error) {
        if (!env.AI_FAIL_OPEN) throw error
        const reason =
          error instanceof ApiError
            ? error.code
            : error instanceof Error
              ? error.message
              : 'provider_error'
        return fallbackResult(registered, model.id, model.version, model.provider, started, reason, [reason])
      }
    }

    let result: ExecutionResult
    if (cacheEnabled && request.options?.cache !== 'refresh') {
      const inflight = pendingExecutions.get(cacheKey)
      if (inflight) {
        result = await inflight
      } else {
        const promise = runModel()
        pendingExecutions.set(cacheKey, promise)
        try {
          result = await promise
        } finally {
          pendingExecutions.delete(cacheKey)
        }
      }
    } else {
      result = await runModel()
    }

    if (cacheEnabled && result.validation.ok && result.mode !== 'fallback') {
      appCache.set(cacheKey, result)
    }
    return result
  }
}
