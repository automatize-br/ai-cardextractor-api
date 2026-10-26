import { ApiError } from '../../exceptions/ApiError.ts'
import { describeModels, disposeProvider, getProvider, resolveModelConfig } from '../../providers/llm/index.ts'
import type { ModelConfig } from '../../types/llm.ts'

export interface ModelView extends ModelConfig {
  ready: boolean
}

export default class ModelService {
  static async list(): Promise<ModelView[]> {
    return describeModels()
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
