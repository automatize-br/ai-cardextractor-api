import { ApiError } from '../../exceptions/ApiError.ts'
import { modelApiKey } from '../../config/models.ts'
import type { RegisteredModel } from '../../types/model.ts'
import type {
  CatalogCompletionInput,
  CatalogCompletionResult,
  CatalogLlmProvider,
} from './catalogProvider.ts'

// ============================================================================
// Anthropic Messages API.
//
// - Structured output: output_config.format = { type: "json_schema", schema }.
// - Prompt caching: cache_control no bloco system (prefixo estável).
// - Uso normalizado: input_tokens/output_tokens/cache_read/cache_creation.
// ============================================================================

interface AnthropicResponse {
  content?: Array<{ type?: unknown; text?: unknown }>
  usage?: Record<string, unknown>
  stop_reason?: unknown
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export class AnthropicProvider implements CatalogLlmProvider {
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
      const body: Record<string, unknown> = {
        model: this.model.model,
        max_tokens: input.maxTokens,
        temperature: input.temperature,
        messages: [{ role: 'user', content: input.user }],
      }

      if (this.model.promptCaching !== 'off') {
        body['system'] = [
          {
            type: 'text',
            text: input.system,
            cache_control: { type: 'ephemeral' },
          },
        ]
      } else {
        body['system'] = input.system
      }

      if (this.model.structuredOutput === 'json_schema') {
        body['output_config'] = {
          format: {
            type: 'json_schema',
            schema: input.outputSchema,
          },
        }
      }

      const apiKey = modelApiKey(this.model)
      const response = await fetch(`${this.model.baseUrl.replace(/\/+$/, '')}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(apiKey !== '' ? { 'x-api-key': apiKey } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw ApiError.modelUnavailable(`Anthropic responded ${response.status}`)
      }

      const payload = (await response.json()) as AnthropicResponse
      const content = Array.isArray(payload.content)
        ? payload.content.find((block) => block.type === 'text' && typeof block.text === 'string')
        : null
      if (!content || typeof content.text !== 'string') {
        throw ApiError.modelUnavailable('Anthropic returned no text content')
      }

      return {
        text: content.text,
        tokensIn: numberOrZero(payload.usage?.['input_tokens']),
        tokensOut: numberOrZero(payload.usage?.['output_tokens']),
        cachedTokens: numberOrZero(payload.usage?.['cache_read_input_tokens']),
        cacheWriteTokens: numberOrZero(payload.usage?.['cache_creation_input_tokens']),
        latencyMs: Date.now() - started,
        finishReason: typeof payload.stop_reason === 'string' ? payload.stop_reason : null,
      }
    } catch (error) {
      if (controller.signal.aborted) throw new ApiError(503, 'MODEL_TIMEOUT', 'Model timed out')
      throw error instanceof ApiError ? error : ApiError.modelUnavailable('Anthropic request failed')
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  async dispose(): Promise<void> {
    // stateless
  }
}
