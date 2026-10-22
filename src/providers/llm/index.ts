import { env } from '../../config/env.ts'
import { FakeProvider } from './fakeProvider.ts'
import { HttpProvider } from './httpProvider.ts'
import { LlamaCppProvider } from './llamaCppProvider.ts'
import type { LlmProvider, LlmProviderName, ModelConfig } from './types.ts'

// ============================================================================
// Registro de modelos/providers. A configuracao base vem de env; modelos
// adicionais podem ser declarados em AI_MODELS_JSON. Instancias sao cacheadas
// por modelId — trocar de modelo nao recarrega o processo.
// ============================================================================

const PROVIDERS: readonly LlmProviderName[] = ['fake', 'llamacpp', 'http']

function defaultModel(): ModelConfig {
  return {
    id: env.AI_MODEL_ID,
    provider: env.LLM_PROVIDER,
    path: env.AI_MODEL_PATH,
    contextSize: env.AI_MODEL_CONTEXT,
    version: env.AI_MODEL_VERSION || `${env.AI_MODEL_ID}@1`,
  }
}

function isProviderName(value: unknown): value is LlmProviderName {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value)
}

function parseExtraModels(): ModelConfig[] {
  if (env.AI_MODELS_JSON === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(env.AI_MODELS_JSON)
  } catch {
    throw new Error('AI_MODELS_JSON must be valid JSON')
  }
  if (!Array.isArray(parsed)) throw new Error('AI_MODELS_JSON must be an array')

  const models: ModelConfig[] = []
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) throw new Error('AI_MODELS_JSON item must be an object')
    const item = raw as Record<string, unknown>
    if (typeof item['id'] !== 'string' || item['id'] === '') throw new Error('AI_MODELS_JSON item.id is required')
    const provider = item['provider'] ?? env.LLM_PROVIDER
    if (!isProviderName(provider)) throw new Error('AI_MODELS_JSON item.provider is invalid')
    models.push({
      id: item['id'],
      provider,
      path: typeof item['path'] === 'string' ? item['path'] : env.AI_MODEL_PATH,
      contextSize: typeof item['contextSize'] === 'number' ? item['contextSize'] : env.AI_MODEL_CONTEXT,
      version: typeof item['version'] === 'string' ? item['version'] : `${item['id']}@1`,
    })
  }
  return models
}

let cachedConfigs: ModelConfig[] | null = null

export function listModelConfigs(): ModelConfig[] {
  if (cachedConfigs) return cachedConfigs
  const all = [defaultModel(), ...parseExtraModels()]
  const byId = new Map<string, ModelConfig>()
  for (const model of all) {
    if (!byId.has(model.id)) byId.set(model.id, model)
  }
  cachedConfigs = [...byId.values()]
  return cachedConfigs
}

export function resolveModelConfig(modelId: string | null): ModelConfig | null {
  const models = listModelConfigs()
  if (modelId === null) return models[0] ?? null
  return models.find((model) => model.id === modelId) ?? null
}

const instances = new Map<string, LlmProvider>()

function createProvider(config: ModelConfig): LlmProvider {
  switch (config.provider) {
    case 'fake':
      return new FakeProvider(config.id, config.version)
    case 'llamacpp':
      return new LlamaCppProvider(config)
    case 'http':
      return new HttpProvider(config, env.LLM_HTTP_BASE_URL, env.LLM_HTTP_API_KEY, env.LLM_HTTP_MODEL)
  }
}

export function getProvider(modelId: string | null): LlmProvider {
  const config = resolveModelConfig(modelId)
  if (!config) throw new Error(`Unknown model: ${modelId ?? '(default)'}`)
  const existing = instances.get(config.id)
  if (existing) return existing
  const created = createProvider(config)
  instances.set(config.id, created)
  return created
}

export async function disposeProvider(modelId: string): Promise<boolean> {
  const provider = instances.get(modelId)
  if (!provider) return false
  // Mantem no registry enquanto drena: evita criar um segundo modelo
  // (OOM) durante o unload.
  await provider.dispose()
  if (instances.get(modelId) === provider) instances.delete(modelId)
  return true
}

export async function disposeProviders(): Promise<void> {
  const all = [...instances.values()]
  await Promise.all(all.map((provider) => provider.dispose().catch(() => undefined)))
  instances.clear()
}

export async function describeModels(): Promise<Array<ModelConfig & { ready: boolean }>> {
  const result: Array<ModelConfig & { ready: boolean }> = []
  for (const config of listModelConfigs()) {
    const provider = getProvider(config.id)
    result.push({ ...config, ready: await provider.isReady().catch(() => false) })
  }
  return result
}

export type * from './types.ts'
