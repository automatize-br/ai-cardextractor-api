import { z } from 'zod'
import { env } from './env.ts'
import { computeHash } from '../helpers/packHash.ts'
import type {
  CatalogModel,
  CatalogProvider,
  ModelCost,
  PromptCachingMode,
  RegisteredModel,
  StructuredOutputMode,
} from '../types/model.ts'

// ============================================================================
// Catálogo de modelos v2. Lido de AI_MODELS_JSON; se ausente, sintetiza um
// modelo legado a partir de LLM_PROVIDER/LLM_HTTP_* para não quebrar o fluxo
// antigo. O runtime novo (/v1/execute) exige catálogo explícito.
// ============================================================================

const PROVIDERS = ['fake', 'openai', 'anthropic', 'gemini', 'openai-compatible'] as const
const STRUCTURED_OUTPUT = ['json_schema', 'tool', 'grammar', 'json_object', 'none'] as const
const PROMPT_CACHING = ['auto', 'explicit', 'off'] as const

const API_KEY_ALLOWLIST = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'AI_LLM_API_KEY',
  'LLM_HTTP_API_KEY', // compatibilidade temporária com o provider http legado
])

const costSchema = z
  .object({
    inputPerM: z.number().finite().nonnegative(),
    outputPerM: z.number().finite().nonnegative(),
  })
  .strict()

const modelSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    version: z.string().trim().min(1).max(120),
    provider: z.enum(PROVIDERS),
    model: z.string().trim().min(1).max(160),
    baseUrl: z.string().trim().max(500).default(''),
    apiKeyEnv: z.string().trim().max(80).default(''),
    structuredOutput: z.enum(STRUCTURED_OUTPUT).default('json_schema'),
    promptCaching: z.enum(PROMPT_CACHING).default('auto'),
    maxContext: z.number().int().positive().max(10_000_000).default(128_000),
    maxOutput: z.number().int().positive().max(1_000_000).default(2048),
    cost: costSchema.nullable().default(null),
  })
  .strict()

const catalogSchema = z.array(modelSchema)

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

function assertUrl(value: string, label: string): void {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('protocol must be http or https')
    }
    if (url.protocol === 'http:' && !isLoopbackUrl(value) && !env.AI_ALLOW_INSECURE_LLM_URL) {
      throw new Error('http:// is only allowed for loopback; set AI_ALLOW_INSECURE_LLM_URL=true to override')
    }
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : 'invalid URL'}`)
  }
}

function assertApiKeyPolicy(item: CatalogModel): void {
  if (item.provider === 'fake') {
    if (item.apiKeyEnv !== '' && !API_KEY_ALLOWLIST.has(item.apiKeyEnv)) {
      throw new Error(`AI_MODELS_JSON item "${item.id}": apiKeyEnv "${item.apiKeyEnv}" is not allowlisted`)
    }
    return
  }

  if (item.apiKeyEnv === '') {
    if (item.provider !== 'openai-compatible' || !isLoopbackUrl(item.baseUrl)) {
      throw new Error(
        `AI_MODELS_JSON item "${item.id}": apiKeyEnv is required unless provider is openai-compatible on loopback`,
      )
    }
    return
  }

  if (!API_KEY_ALLOWLIST.has(item.apiKeyEnv)) {
    throw new Error(`AI_MODELS_JSON item "${item.id}": apiKeyEnv "${item.apiKeyEnv}" is not allowlisted`)
  }
}

function assertModel(item: CatalogModel): void {
  if (item.provider === 'fake') {
    assertApiKeyPolicy(item)
    return
  }
  if (item.baseUrl === '') {
    throw new Error(`AI_MODELS_JSON item "${item.id}": baseUrl is required for provider "${item.provider}"`)
  }
  assertUrl(item.baseUrl, `AI_MODELS_JSON item "${item.id}".baseUrl`)
  assertApiKeyPolicy(item)
}

function parseCatalog(): CatalogModel[] {
  const rawText = (process.env['AI_MODELS_JSON'] ?? '').trim()
  if (rawText === '') return []

  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    throw new Error('AI_MODELS_JSON must be valid JSON')
  }

  // Formato legado (path/contextSize) não é aceito silenciosamente.
  if (Array.isArray(parsed)) {
    for (const [index, value] of parsed.entries()) {
      if (typeof value !== 'object' || value === null) continue
      const record = value as Record<string, unknown>
      if (
        (typeof record['path'] === 'string' || typeof record['contextSize'] === 'number') &&
        typeof record['model'] !== 'string'
      ) {
        throw new Error(
          `AI_MODELS_JSON[${index}] usa o formato antigo (path/contextSize). Migre para {id,version,provider,model,baseUrl,apiKeyEnv}.`,
        )
      }
    }
  }

  const result = catalogSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `AI_MODELS_JSON invalid: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    )
  }

  const models = result.data.map(
    (item): CatalogModel => ({
      ...item,
      provider: item.provider as CatalogProvider,
      structuredOutput: item.structuredOutput as StructuredOutputMode,
      promptCaching: item.promptCaching as PromptCachingMode,
      cost: item.cost as ModelCost | null,
    }),
  )

  const ids = new Set<string>()
  for (const model of models) {
    if (ids.has(model.id)) throw new Error(`AI_MODELS_JSON has duplicate model id "${model.id}"`)
    ids.add(model.id)
    assertModel(model)
  }
  return models
}

function legacyDefaultModel(): CatalogModel[] {
  const provider = env.LLM_PROVIDER
  if (provider === 'fake') {
    return [
      {
        id: env.AI_MODEL_ID,
        version: env.AI_MODEL_VERSION || `${env.AI_MODEL_ID}@1`,
        provider: 'fake',
        model: env.AI_MODEL_ID,
        baseUrl: '',
        apiKeyEnv: '',
        structuredOutput: 'json_schema',
        promptCaching: 'off',
        maxContext: env.AI_MODEL_CONTEXT,
        maxOutput: env.LLM_MAX_TOKENS,
        cost: null,
      },
    ]
  }

  if (provider === 'http') {
    return [
      {
        id: env.AI_MODEL_ID,
        version: env.AI_MODEL_VERSION || `${env.AI_MODEL_ID}@1`,
        provider: 'openai-compatible',
        model: env.LLM_HTTP_MODEL || env.AI_MODEL_ID,
        baseUrl: env.LLM_HTTP_BASE_URL,
        apiKeyEnv: 'LLM_HTTP_API_KEY',
        structuredOutput: 'json_schema',
        promptCaching: 'off',
        maxContext: env.AI_MODEL_CONTEXT,
        maxOutput: env.LLM_MAX_TOKENS,
        cost: null,
      },
    ]
  }

  // llamacpp nativo: o pipeline v2 não o usa; o fluxo legado continua via
  // providers/llm/index.ts. Catálogo vazio evita prometer algo que não existe.
  return []
}

let cached: RegisteredModel[] | null = null

export function listModels(): RegisteredModel[] {
  if (cached) return cached
  const configured = parseCatalog()
  const models = configured.length > 0 ? configured : legacyDefaultModel()
  cached = models.map((model) => ({
    ...model,
    modelHash: computeHash({
      id: model.id,
      version: model.version,
      provider: model.provider,
      model: model.model,
      baseUrl: model.baseUrl,
      structuredOutput: model.structuredOutput,
      promptCaching: model.promptCaching,
      maxContext: model.maxContext,
      maxOutput: model.maxOutput,
    }),
  }))
  return cached
}

export function getModel(id: string | null): RegisteredModel | null {
  const models = listModels()
  if (id === null || id === '') {
    const defaultId = env.AI_DEFAULT_MODEL || models[0]?.id || ''
    return models.find((model) => model.id === defaultId) ?? models[0] ?? null
  }
  return models.find((model) => model.id === id) ?? null
}

export function getDefaultModel(): RegisteredModel | null {
  return getModel(null)
}

export function resetModelsForTests(): void {
  cached = null
}

export function modelApiKey(model: CatalogModel): string {
  if (model.apiKeyEnv === '') return ''
  return (process.env[model.apiKeyEnv] ?? '').trim()
}
