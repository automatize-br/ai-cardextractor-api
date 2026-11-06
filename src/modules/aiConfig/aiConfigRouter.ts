import express from 'express'
import { internalAuthMiddleware } from '../../middleware/internalAuth.middleware.ts'
import AiConfigController from './aiConfigController.ts'

const router = express.Router()

// Recebe a config dinâmica de IA (painel admin) + teste opcional do modelo.
router.post('/apply', internalAuthMiddleware, AiConfigController.apply)

export default router
