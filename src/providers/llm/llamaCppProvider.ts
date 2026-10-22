import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  Llama,
  LlamaChatSession,
  LlamaContext,
  LlamaContextSequence,
  LlamaGrammar,
  LlamaModel,
} from 'node-llama-cpp'
import { env } from '../../config/env.ts'
import { ApiError } from '../../exceptions/ApiError.ts'
import { RESPONSE_GRAMMAR } from './grammar.ts'
import type { CompletionInput, CompletionResult, LlmProvider, ModelConfig } from './types.ts'

// ============================================================================
// Provider local (node-llama-cpp).
//
// - Carregamento preguicoso + SINGLE-FLIGHT (varias requisicoes nao carregam
//   o modelo duas vezes).
// - Fila interna: o llama.cpp processa um prompt por vez; requisicoes
//   concorrentes esperam a vez em vez de falhar (o timeout e do cliente).
// - Cada chamada usa UMA sequence; ela e SEMPRE devolvida ao pool.
// - Abort/timeout no meio da geracao NAO pode ser reportado como sucesso.
// ============================================================================

export class LlamaCppProvider implements LlmProvider {
  readonly name = 'llamacpp' as const
  readonly modelId: string
  readonly modelVersion: string

  private readonly config: ModelConfig
  private llama: Llama | null = null
  private model: LlamaModel | null = null
  private context: LlamaContext | null = null
  private grammar: LlamaGrammar | null = null
  private loadPromise: Promise<void> | null = null
  private loadGeneration = 0
  private tail: Promise<unknown> = Promise.resolve()
  private pendingTasks = 0
  private disposed = false

  constructor(config: ModelConfig) {
    this.config = config
    this.modelId = config.id
    this.modelVersion = config.version
  }

  async load(): Promise<void> {
    await this.enqueue(() => this.ensureLoaded())
  }

  async isReady(): Promise<boolean> {
    return this.context !== null
  }

  private ensureLoaded(): Promise<void> {
    if (this.context) return Promise.resolve()
    if (this.disposed) return Promise.reject(ApiError.modelUnavailable('Provider disposed'))
    if (this.loadPromise) return this.loadPromise

    const generation = this.loadGeneration
    this.loadPromise = this.loadWithTimeout(generation)
      .catch(async (error: unknown) => {
        // Nao deixa estado parcial envenenado: a proxima chamada tenta de novo.
        await this.releaseResources()
        throw error
      })
      .finally(() => {
        this.loadPromise = null
      })

    return this.loadPromise
  }

  private async loadWithTimeout(generation: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Invalida o load em andamento: ao terminar, ele mesmo libera os
        // recursos locais em vez de reanimar um provider descartado.
        this.loadGeneration += 1
        reject(ApiError.modelUnavailable('Model load timed out'))
      }, Math.max(1, env.LLM_LOAD_TIMEOUT_MS))
    })
    try {
      await Promise.race([this.loadInternal(generation), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private isStale(generation: number): boolean {
    return this.disposed || generation !== this.loadGeneration
  }

  private async loadInternal(generation: number): Promise<void> {
    const modelPath = resolve(this.config.path)
    try {
      await stat(modelPath)
    } catch {
      throw ApiError.modelUnavailable(`Model file not found: ${this.config.id}`)
    }

    const { getLlama, LlamaGrammar: GrammarClass } = await import('node-llama-cpp')
    const llama = await getLlama({ gpu: false })
    if (this.isStale(generation)) {
      await llama.dispose().catch(() => undefined)
      throw ApiError.modelUnavailable('Model load aborted')
    }

    const model = await llama.loadModel({ modelPath })
    if (this.isStale(generation)) {
      await model.dispose().catch(() => undefined)
      await llama.dispose().catch(() => undefined)
      throw ApiError.modelUnavailable('Model load aborted')
    }

    const context = await model.createContext({ contextSize: this.config.contextSize })
    if (this.isStale(generation)) {
      await context.dispose().catch(() => undefined)
      await model.dispose().catch(() => undefined)
      await llama.dispose().catch(() => undefined)
      throw ApiError.modelUnavailable('Model load aborted')
    }

    try {
      const grammar = new GrammarClass(llama, { grammar: RESPONSE_GRAMMAR })
      if (this.isStale(generation)) {
        throw ApiError.modelUnavailable('Model load aborted')
      }
      this.llama = llama
      this.model = model
      this.context = context
      this.grammar = grammar
    } catch (error) {
      await context.dispose().catch(() => undefined)
      if (!this.llama) {
        await model.dispose().catch(() => undefined)
        await llama.dispose().catch(() => undefined)
      }
      throw error
    }
  }

  /** Serializa as inferencias; nunca rejeita a cadeia. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.pendingTasks >= env.LLM_MAX_QUEUE) {
      return Promise.reject(ApiError.modelUnavailable('Model queue full'))
    }
    this.pendingTasks += 1
    const run = this.tail.then(task, task)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run.finally(() => {
      this.pendingTasks -= 1
    })
  }

  async complete(input: CompletionInput): Promise<CompletionResult> {
    const deadline = Date.now() + input.timeoutMs
    return this.enqueue(async () => {
      if (this.disposed) throw ApiError.modelUnavailable('Provider disposed')
      if (input.signal?.aborted) throw new ApiError(503, 'MODEL_TIMEOUT', 'Model timed out')

      await this.ensureLoaded()
      // O cliente pode ter abortado durante um load de varios segundos.
      if (input.signal?.aborted) throw new ApiError(503, 'MODEL_TIMEOUT', 'Model timed out')
      if (!this.context || !this.grammar) throw ApiError.modelUnavailable('Model not loaded')

      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new ApiError(503, 'MODEL_TIMEOUT', 'Model timed out')

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), remaining)
      const onExternalAbort = (): void => controller.abort()
      input.signal?.addEventListener('abort', onExternalAbort)

      let session: LlamaChatSession | null = null
      let sequence: LlamaContextSequence | null = null
      try {
        sequence = this.context.getSequence()
        session = new (await import('node-llama-cpp')).LlamaChatSession({
          contextSequence: sequence,
          systemPrompt: input.system,
        })

        const started = Date.now()
        const text = await session.prompt(input.user, {
          maxTokens: input.maxTokens,
          temperature: input.temperature,
          signal: controller.signal,
          stopOnAbortSignal: true,
          grammar: this.grammar,
        })

        // `stopOnAbortSignal` devolve texto PARCIAL em vez de lancar. Sem esta
        // checagem, um timeout no meio da geracao viraria "sucesso".
        if (controller.signal.aborted) throw new ApiError(503, 'MODEL_TIMEOUT', 'Model timed out')

        return {
          text,
          tokensIn: Math.ceil((input.system.length + input.user.length) / 4),
          tokensOut: Math.ceil(text.length / 4),
          latencyMs: Date.now() - started,
        }
      } catch (error) {
        if (controller.signal.aborted) throw new ApiError(503, 'MODEL_TIMEOUT', 'Model timed out')
        throw error instanceof ApiError ? error : ApiError.modelUnavailable('Model inference failed')
      } finally {
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', onExternalAbort)
        try {
          if (session) session.dispose({ disposeSequence: true })
          else sequence?.dispose()
        } catch (error) {
          console.error('[llama] dispose session:', error instanceof Error ? error.message : error)
        }
      }
    })
  }

  private async releaseResources(): Promise<void> {
    this.loadGeneration += 1
    const context = this.context
    const model = this.model
    const llama = this.llama
    this.context = null
    this.grammar = null
    this.model = null
    this.llama = null

    if (context) await context.dispose().catch(() => undefined)
    if (model) await model.dispose().catch(() => undefined)
    if (llama) await llama.dispose().catch(() => undefined)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    // Espera a inferencia em andamento terminar antes de liberar o contexto.
    await this.tail.catch(() => undefined)
    await this.releaseResources()
  }
}
