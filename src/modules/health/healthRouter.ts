import express from 'express'
import { getAdjMode } from '../../config/env.ts'
import { getDefaultModel } from '../../config/models.ts'
import { getDefaultProfile } from '../../config/profiles.ts'
import { sendSuccess } from '../../helpers/apiResponse.ts'
import { internalAuthMiddleware } from '../../middleware/internalAuth.middleware.ts'
import { listModelConfigs, getProvider } from '../../providers/llm/index.ts'

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
  const configs = listModelConfigs()
  const defaultModel = configs[0] ?? null
  const ready = defaultModel ? await getProvider(defaultModel.id).isReady().catch(() => false) : false
  sendSuccess(res, {
    ready,
    modelId: defaultModel?.id ?? null,
    provider: defaultModel?.provider ?? null,
  })
})

export default router
