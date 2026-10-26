import express from 'express'
import { internalAuthMiddleware } from '../../middleware/internalAuth.middleware.ts'
import AdjudicationController from './adjudicationController.ts'

const router = express.Router()

router.post('/adjudicate', internalAuthMiddleware, AdjudicationController.adjudicate)
router.get('/stats', internalAuthMiddleware, AdjudicationController.stats)

export default router
