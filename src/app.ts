import compression from 'compression'
import cors from 'cors'
import express from 'express'
import type { Express, Request, Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import helmet from 'helmet'
import { corsOriginCallback } from './config/cors.ts'
import { env } from './config/env.ts'
import defaultRouter from './defaultRouter.ts'
import ExtractionRouter from './modules/extraction/extractionRouter.ts'
import AiConfigRouter from './modules/aiConfig/aiConfigRouter.ts'
import { errorMiddleware } from './middleware/error.middleware.ts'
import { requestIdMiddleware } from './middleware/requestId.middleware.ts'

// App Express sem side effects de processo (sem DB, sem listen). Permite testes
// de integracao em porta efemera.
export function createApp(): Express {
  const app = express()

  const trustProxyHops = Number(env.TRUST_PROXY)
  app.set('trust proxy', Number.isFinite(trustProxyHops) && trustProxyHops > 0 ? trustProxyHops : false)

  app.use(helmet({ contentSecurityPolicy: false }))
  app.use(compression())
  app.use(cors({ origin: corsOriginCallback, exposedHeaders: ['x-request-id'] }))
  app.use(express.json({ limit: '1mb' }))
  app.use(requestIdMiddleware)

  // Health check publico e simples para monitoramento da VPS.
  // Fica ANTES do limiter para nao exigir autenticacao nem sofrer 429.
  app.get('/api/v1/helt', (_req: Request, res: Response) => {
    res.status(200).type('text/plain').send('api-scrapping funcionando ok')
  })

  // Extração interna: corpo binário e volume alto; fora do limiter público.
  app.use('/api/v1', ExtractionRouter)
  app.use('/v1', ExtractionRouter)
  app.use('/api/v1/internal/ai-config', AiConfigRouter)
  app.use('/v1/internal/ai-config', AiConfigRouter)

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 1200,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' },
  })

  app.use('/api/v1', apiLimiter, defaultRouter)
  // Alias sem o prefixo /api: o contrato de integracao cita /v1.
  app.use('/v1', apiLimiter, defaultRouter)

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Route not found' })
  })

  app.use(errorMiddleware)
  return app
}

export default createApp
