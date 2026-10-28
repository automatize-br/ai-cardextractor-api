import express from 'express'
import { getAdjMode } from '../../config/env.ts'
import { getDefaultModel } from '../../config/models.ts'
import { getDefaultProfile } from '../../config/profiles.ts'
import { getCatalogProvider } from '../../providers/llm/catalogProvider.ts'
import { sendSuccess } from '../../helpers/apiResponse.ts'
import { internalAuthMiddleware } from '../../middleware/internalAuth.middleware.ts'

const router = express.Router()

// Liveness publico: sem caminho de modelo, sem segredos.
router.get('/health', (_req, res) => {
  const profile = getDefaultProfile()
  const model = getDefaultModel()
  sendSuccess(res, {
    status: 'ok',
    mode: getAdjMode(),
    defaultProfile: profile?.profile.id ?? null,
    defaultModel: model?.id ?? null,
    provider: model?.provider ?? null,
  })
})

// Readiness interna: informa se o modelo default esta carregado.
router.get('/ready', internalAuthMiddleware, async (_req, res) => {
  // Usa o catálogo v2 (inclui o modelo dinâmico `fast` do painel admin), não
  // o registry legado — que pode estar vazio quando LLM_PROVIDER é llamacpp.
  const model = getDefaultModel()
  const ready = model ? await getCatalogProvider(model).isReady().catch(() => false) : false
  sendSuccess(res, {
    ready,
    modelId: model?.id ?? null,
    provider: model?.provider ?? null,
  })
})

export default router
