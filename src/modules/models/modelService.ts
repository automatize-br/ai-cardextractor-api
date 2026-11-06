import { ApiError } from '../../exceptions/ApiError.ts'
import { listModels } from '../../config/models.ts'
import { describeModels, disposeProvider, getProvider, resolveModelConfig } from '../../providers/llm/index.ts'
import { getCatalogProvider } from '../../providers/llm/catalogProvider.ts'
import type { ModelConfig } from '../../types/llm.ts'

export interface ModelView extends ModelConfig {
  ready: boolean
}

export interface CatalogModelView {
  id: string
  version: string
  provider: string
  model: string
  structuredOutput: string
  promptCaching: string
  ready: boolean
}

export default class ModelService {
  static async list(): Promise<ModelView[]> {
    return describeModels()
  }

  static async listCatalog(): Promise<CatalogModelView[]> {
    const models = listModels()
    return Promise.all(
      models.map(async (model) => ({
        id: model.id,
        version: model.version,
        provider: model.provider,
        model: model.model,
        structuredOutput: model.structuredOutput,
        promptCaching: model.promptCaching,
        ready: await getCatalogProvider(model).isReady().catch(() => false),
      })),
    )
  }

  static async load(modelId: string): Promise<ModelView> {
    if (!resolveModelConfig(modelId)) throw ApiError.notFound('Model not found')
    const provider = getProvider(modelId)
    await provider.load()
    const config = resolveModelConfig(modelId)
    if (!config) throw ApiError.notFound('Model not found')
    return { ...config, ready: await provider.isReady() }
  }

  static async unload(modelId: string): Promise<{ modelId: string; unloaded: boolean }> {
    if (!resolveModelConfig(modelId)) throw ApiError.notFound('Model not found')
    const unloaded = await disposeProvider(modelId)
    return { modelId, unloaded }
  }
}
