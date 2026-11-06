import express from 'express'
import { internalAuthMiddleware } from '../../middleware/internalAuth.middleware.ts'
import ExecutionController from './executionController.ts'

const router = express.Router()

router.post('/execute', internalAuthMiddleware, ExecutionController.execute)

export default router
