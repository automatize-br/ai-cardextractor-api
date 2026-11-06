import express from 'express'
import { sendSuccess } from '../../helpers/apiResponse.ts'
import { internalAuthMiddleware } from '../../middleware/internalAuth.middleware.ts'
import { profileSummaries } from '../../config/profiles.ts'

const router = express.Router()

// Lista metadados dos perfis. Nunca devolve prompt, schema completo ou segredo.
router.get('/profiles', internalAuthMiddleware, (_req, res) => {
  sendSuccess(res, { profiles: profileSummaries() })
})

export default router
