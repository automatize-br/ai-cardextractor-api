import express from 'express'
import AdjudicationRouter from './modules/adjudication/adjudicationRouter.ts'
import ModelRouter from './modules/models/modelRouter.ts'
import HealthRouter from './modules/health/healthRouter.ts'

const router = express.Router()

router.use('/', HealthRouter)
router.use('/', AdjudicationRouter)
router.use('/models', ModelRouter)

export default router
