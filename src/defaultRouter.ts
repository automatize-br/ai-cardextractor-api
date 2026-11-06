import express from 'express'
import AdjudicationRouter from './modules/adjudication/adjudicationRouter.ts'
import ModelRouter from './modules/models/modelRouter.ts'
import HealthRouter from './modules/health/healthRouter.ts'
import ProfilesRouter from './modules/profiles/profilesRouter.ts'
import ExecutionRouter from './modules/execution/executionRouter.ts'

const router = express.Router()

router.use('/', HealthRouter)
router.use('/', ProfilesRouter)
router.use('/', ExecutionRouter)
router.use('/', AdjudicationRouter)
router.use('/models', ModelRouter)

export default router
