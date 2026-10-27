import { ApiError } from '../../exceptions/ApiError.ts'
import { modelApiKey } from '../../config/models.ts'
import type { RegisteredModel } from '../../types/model.ts'
import type {
  CatalogCompletionInput,
  CatalogCompletionResult,
  CatalogLlmProvider,
} from './catalogProvider.ts'

// ============================================================================
// Google Gemini generateContent API.
//
// - Structured output: responseMimeType + responseSchema (OpenAPI subset).
// - Gemini não aceita additionalProperties/$defs; o schema é sanitizado.
// - Cache de prompt é implícito no Gemini; não há header de cache.
// ============================================================================

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: unknown }> }
    finishReason?: unknown
  }>
  usageMetadata?: Record<string, unknown>
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function sanitizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSchema)
  if (typeof value !== 'object' || value === null) return value

  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(source)) {
    if (['additionalProperties', '$schema', '$id', '$defs', '$ref', 'default', 'examples'].includes(key)) {
      continue
    }
    if (key === 'const') {
      out['enum'] = [child]
      continue
    }
    out[key] = sanitizeSchema(child)
  }
  return out
}

export class GeminiProvider implements CatalogLlmProvider {
  readonly model: RegisteredModel

  constructor(model: RegisteredModel) {
    this.model = model
  }

  async isReady(): Promise<boolean> {
    return this.model.baseUrl !== '' && this.model.model !== ''
  }

  async complete(input: CatalogCompletionInput): Promise<CatalogCompletionResult> {
    if (this.model.baseUrl === '') throw ApiError.modelUnavailable('baseUrl not configured')
    if (input.signal?.aborted) throw new ApiError(503, 'MODEL_TIMEOUT', 'Model timed out')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), input.timeoutMs)
    const onExternalAbort = (): void => controller.abort()
    input.signal?.addEventListener('abort', onExternalAbort)

    const started = Date.now()
    try {
      const generationConfig: Record<string, unknown> = {
        temperature: input.temperature,
        topP: input.topP,
        maxOutputTokens: input.maxTokens,
      }
      if (this.model.structuredOutput === 'json_schema') {
        generationConfig['responseMimeType'] = 'application/json'
        generationConfig['responseSchema'] = sanitizeSchema(input.outputSchema)
      } else if (this.model.structuredOutput === 'json_object') {
        generationConfig['responseMimeType'] = 'application/json'
      }

      const body = {
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [{ role: 'user', parts: [{ text: input.user }] }],
        generationConfig,
      }

      const modelPath = this.model.model.startsWith('models/')
        ? this.model.model
        : `models/${this.model.model}`
      const apiKey = modelApiKey(this.model)
      const response = await fetch(
        `${this.model.baseUrl.replace(/\/+$/, '')}/${modelPath}:generateContent`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey !== '' ? { 'x-goog-api-key': apiKey } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      )

      if (!response.ok) {
        throw ApiError.modelUnavailable(`Gemini responded ${response.status}`)
      }

      const payload = (await response.json()) as GeminiResponse
      const candidate = payload.candidates?.[0]
      const text = Array.isArray(candidate?.content?.parts)
        ? candidate.content.parts
            .map((part) => (typeof part.text === 'string' ? part.text : ''))
            .join('')
        : ''
      if (text === '') throw ApiError.modelUnavailable('Gemini returned no text content')

      return {
        text,
        tokensIn: numberOrZero(payload.usageMetadata?.['promptTokenCount']),
        tokensOut: numberOrZero(payload.usageMetadata?.['candidatesTokenCount']),
        cachedTokens: numberOrZero(payload.usageMetadata?.['cachedContentTokenCount']),
        cacheWriteTokens: 0,
        latencyMs: Date.now() - started,
        finishReason: typeof candidate?.finishReason === 'string' ? candidate.finishReason : null,
      }
    } catch (error) {
      if (controller.signal.aborted) throw new ApiError(503, 'MODEL_TIMEOUT', 'Model timed out')
      throw error instanceof ApiError ? error : ApiError.modelUnavailable('Gemini request failed')
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  async dispose(): Promise<void> {
    // stateless
  }
}
