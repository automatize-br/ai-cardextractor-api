import express from 'express'
import type { Request, RequestHandler } from 'express'
import { env } from '../../config/env.ts'
import { ApiError } from '../../exceptions/ApiError.ts'
import { internalAuthMiddleware } from '../../middleware/internalAuth.middleware.ts'
import ExtractionController from './extractionController.ts'

const router = express.Router()

/**
 * Lê o corpo binário SEM descompactar (o controller valida o teto do gzip e do
 * HTML descompactado). O `express.raw` inflaria o gzip antes da validação e
 * rejeitaria `content-encoding` com 415 quando `inflate: false`.
 */
function rawBody(limit: number): RequestHandler {
  return (req: Request, _res, next) => {
    const chunks: Buffer[] = []
    let total = 0
    let exceeded = false
    req.on('data', (chunk: Buffer) => {
      if (exceeded) return
      total += chunk.length
      if (total > limit) {
        exceeded = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (exceeded) {
        next(new ApiError(413, 'PACK_TOO_LARGE', `body exceeds ${limit} bytes`))
        return
      }
      req.body = Buffer.concat(chunks)
      next()
    })
    req.on('error', (error) => next(error))
  }
}

// Rota interna de extração: corpo binário (HTML/gzip), metadados no header.
// Montada fora do rate limiter público em app.ts.
router.post('/extract', internalAuthMiddleware, rawBody(env.EXTRACTOR_BODY_LIMIT_BYTES), ExtractionController.extract)

export default router
