import { applyRuntimeAiConfig } from './runtimeConfig.ts'
import { resetModelsForTests } from '../../config/models.ts'
import { resetCatalogProvidersForTests } from '../../providers/llm/catalogProvider.ts'

/** Aplica a config e invalida caches de modelo/provider (sem reiniciar). */
export function applyAiConfig(raw: unknown): { applied: boolean; version: number | null } {
  const result = applyRuntimeAiConfig(raw)
  if (result.applied) {
    resetModelsForTests()
    resetCatalogProvidersForTests()
  }
  return result
}
