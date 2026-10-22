import { ApiError } from '../../exceptions/ApiError.ts'
import type { CompletionInput, CompletionResult, LlmProvider, ModelConfig } from './types.ts'

// ============================================================================
// Provider HTTP OpenAI-compatible (llama.cpp server, vLLM ou endpoint remoto
// com GPU). Nao depende de SDK: usa fetch nativo do Node 20.
// ============================================================================

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
}

export class HttpProvider implements LlmProvider {
  readonly name = 'http' as const
  readonly modelId: string
  readonly modelVersion: string

  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly model: string

  constructor(config: ModelConfig, baseUrl: string, apiKey: string, model: string) {
    this.modelId = config.id
    this.modelVersion = config.version
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.apiKey = apiKey
    this.model = model
  }

  async load(): Promise<void> {
    // stateless (o servidor remoto carrega o modelo)
  }

  async isReady(): Promise<boolean> {
    return this.baseUrl !== '' && this.model !== ''
  }

  async complete(input: CompletionInput): Promise<CompletionResult> {
    if (this.baseUrl === '') throw ApiError.modelUnavailable('LLM_HTTP_BASE_URL not configured')
    if (input.signal?.aborted) throw new ApiError(503, 'MODEL_TIMEOUT', 'Model timed out')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), input.timeoutMs)
    const onExternalAbort = (): void => controller.abort()
    input.signal?.addEventListener('abort', onExternalAbort)

    const started = Date.now()
    try {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
        max_tokens: input.maxTokens,
        temperature: input.temperature,
        stream: false,
      }
      if (input.grammar) body['grammar'] = input.grammar

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey !== '' ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw ApiError.modelUnavailable(`HTTP provider responded ${response.status}`)
      }

      const payload = (await response.json()) as ChatCompletionResponse
      const content = payload.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        throw ApiError.modelUnavailable('HTTP provider returned no content')
      }

      const promptTokens = Number(payload.usage?.prompt_tokens ?? 0)
      const completionTokens = Number(payload.usage?.completion_tokens ?? 0)

      return {
        text: content,
        tokensIn: Number.isFinite(promptTokens) ? promptTokens : 0,
        tokensOut: Number.isFinite(completionTokens) ? completionTokens : 0,
        latencyMs: Date.now() - started,
      }
    } catch (error) {
      if (controller.signal.aborted) throw new ApiError(503, 'MODEL_TIMEOUT', 'Model timed out')
      throw error instanceof ApiError ? error : ApiError.modelUnavailable('HTTP provider failed')
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  async dispose(): Promise<void> {
    // stateless
  }
}
