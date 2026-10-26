import express from 'express'
import { internalAuthMiddleware } from '../../middleware/internalAuth.middleware.ts'
import ModelController from './modelController.ts'

const router = express.Router()

router.use(internalAuthMiddleware)
router.get('/', ModelController.list)
router.post('/:modelId/load', ModelController.load)
router.post('/:modelId/unload', ModelController.unload)

export default router
