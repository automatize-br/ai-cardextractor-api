import { randomUUID } from 'node:crypto'
import { ApiError } from '../../exceptions/ApiError.ts'
import { modelApiKey } from '../../config/models.ts'
import type { RegisteredModel } from '../../types/model.ts'
import type { CompletionMetadata } from '../../types/llm.ts'
import { AnthropicProvider } from './anthropicProvider.ts'
import { GeminiProvider } from './geminiProvider.ts'

// ============================================================================
// Provider de execução do catálogo v2 (modelos declarados no .env).
//
// Nesta fase: `fake` (testes) e `openai-compatible` (OpenAI, OpenRouter, vLLM,
// llama.cpp server, Ollama). Anthropic/Gemini entram na fase de providers
// adicionais; até lá falham explicitamente, sem fallback silencioso.
// ============================================================================

export interface CatalogCompletionInput {
  system: string
  user: string
  outputSchema: Record<string, unknown>
  maxTokens: number
  temperature: number
  topP: number
  timeoutMs: number
  signal: AbortSignal | null
  metadata?: CompletionMetadata
  promptCacheKey?: string
  promptCacheTtl?: string
}

export interface CatalogCompletionResult {
  text: string
  tokensIn: number
  tokensOut: number
  cachedTokens: number
  cacheWriteTokens: number
  latencyMs: number
  finishReason: string | null
}

export interface CatalogLlmProvider {
  readonly model: RegisteredModel
  isReady(): Promise<boolean>
  complete(input: CatalogCompletionInput): Promise<CatalogCompletionResult>
  dispose(): Promise<void>
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>
  usage?: Record<string, unknown>
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function readNestedNumber(record: Record<string, unknown> | undefined, key: string): number {
  if (!record) return 0
  return numberOrZero(record[key])
}

let fakeCatalogCalls = 0

export function fakeCatalogCallCount(): number {
  return fakeCatalogCalls
}

export function resetFakeCatalogCallsForTests(): void {
  fakeCatalogCalls = 0
}

export class FakeCatalogProvider implements CatalogLlmProvider {
  readonly model: RegisteredModel

  constructor(model: RegisteredModel) {
    this.model = model
  }

  async isReady(): Promise<boolean> {
    return true
  }

  async complete(input: CatalogCompletionInput): Promise<CatalogCompletionResult> {
    fakeCatalogCalls += 1
    const started = Date.now()
    const raw = (process.env['FAKE_EXECUTION_OUTPUT'] ?? '').trim()
    const text = raw !== '' ? raw : '{}'
    return {
      text,
      tokensIn: Math.ceil((input.system.length + input.user.length) / 4),
      tokensOut: Math.ceil(text.length / 4),
      cachedTokens: 0,
      cacheWriteTokens: 0,
      latencyMs: Date.now() - started,
      finishReason: 'stop',
    }
  }

  async dispose(): Promise<void> {
    // stateless
  }
}

export class OpenAICompatibleProvider implements CatalogLlmProvider {
  readonly model: RegisteredModel
  private readonly opencodeSession = randomUUID()

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
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
        max_tokens: input.maxTokens,
        temperature: input.temperature,
        top_p: input.topP,
        stream: false,
      }

      if (this.model.structuredOutput === 'json_schema') {
        body['response_format'] = {
          type: 'json_schema',
          json_schema: {
            name: 'output',
            schema: input.outputSchema,
            strict: true,
          },
        }
      } else if (this.model.structuredOutput === 'json_object') {
        body['response_format'] = { type: 'json_object' }
      }

      if (input.promptCacheKey && this.model.promptCaching !== 'off') {
        body['prompt_cache_key'] = input.promptCacheKey
      }

      const apiKey = modelApiKey(this.model)
      let isOpenCode = false
      try {
        isOpenCode = /(^|\.)opencode\.ai$/i.test(new URL(this.model.baseUrl).hostname)
      } catch {
        isOpenCode = false
      }
      const response = await fetch(`${this.model.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey !== '' ? { authorization: `Bearer ${apiKey}` } : {}),
          // OpenCode Go exige uma sessão estável para roteamento/cache.
          ...(isOpenCode ? { 'x-opencode-session': this.opencodeSession, 'user-agent': 'vupia-ai-extractor/1.0' } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 240)
        throw ApiError.modelUnavailable(`HTTP provider responded ${response.status}${detail ? `: ${detail}` : ''}`)
      }

      const payload = (await response.json()) as ChatCompletionResponse
      const content = payload.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        throw ApiError.modelUnavailable('HTTP provider returned no content')
      }

      const usage = payload.usage
      const promptDetails =
        typeof usage?.['prompt_tokens_details'] === 'object' && usage['prompt_tokens_details'] !== null
          ? (usage['prompt_tokens_details'] as Record<string, unknown>)
          : undefined

      return {
        text: content,
        tokensIn: numberOrZero(usage?.['prompt_tokens']),
        tokensOut: numberOrZero(usage?.['completion_tokens']),
        cachedTokens: readNestedNumber(promptDetails, 'cached_tokens'),
        cacheWriteTokens: readNestedNumber(promptDetails, 'cache_write_tokens'),
        latencyMs: Date.now() - started,
        finishReason:
          typeof payload.choices?.[0]?.finish_reason === 'string'
            ? payload.choices[0].finish_reason
            : null,
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

const instances = new Map<string, CatalogLlmProvider>()

export function getCatalogProvider(model: RegisteredModel): CatalogLlmProvider {
  const existing = instances.get(model.id)
  if (existing) return existing

  let created: CatalogLlmProvider
  switch (model.provider) {
    case 'fake':
      created = new FakeCatalogProvider(model)
      break
    case 'openai':
    case 'openai-compatible':
      created = new OpenAICompatibleProvider(model)
      break
    case 'anthropic':
      created = new AnthropicProvider(model)
      break
    case 'gemini':
      created = new GeminiProvider(model)
      break
  }

  instances.set(model.id, created)
  return created
}

export function resetCatalogProvidersForTests(): void {
  instances.clear()
}

export async function disposeCatalogProviders(): Promise<void> {
  const all = [...instances.values()]
  await Promise.all(all.map((provider) => provider.dispose().catch(() => undefined)))
  instances.clear()
}
