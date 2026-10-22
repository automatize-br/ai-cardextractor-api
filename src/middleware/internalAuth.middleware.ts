import type { NextFunction, Request, Response } from 'express'
import { env, isDevelopmentEnvironment } from '../config/env.ts'
import { ApiError } from '../exceptions/ApiError.ts'
import { safeEqual } from '../helpers/constantTime.ts'

// ============================================================================
// Autenticacao interna (API Vupia -> ai-extractor-api).
// Header `x-internal-key` comparado em tempo constante.
// Em dev/TESTE, chave vazia = auth desabilitada (com aviso uma vez no boot).
// Fora de dev/teste, chave vazia derruba o boot em server.ts (fail-closed).
// ============================================================================

let warned = false

export function internalAuthMiddleware(req: Request, _res: Response, next: NextFunction): void {
  if (env.AI_INTERNAL_KEY === '') {
    if (isDevelopmentEnvironment()) {
      if (!warned) {
        warned = true
        console.warn('[auth] AI_INTERNAL_KEY vazia — rotas internas abertas (apenas dev/teste).')
      }
      next()
      return
    }
    next(ApiError.unauthorized('Internal authentication not configured'))
    return
  }

  const provided = req.header('x-internal-key') ?? ''
  if (provided === '' || !safeEqual(provided, env.AI_INTERNAL_KEY)) {
    next(ApiError.unauthorized('Invalid internal key'))
    return
  }
  next()
}
