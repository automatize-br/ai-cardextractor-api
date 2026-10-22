import type { NextFunction, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'

// Correlaciona logs e resposta. Aceita um id do cliente apenas se for curto e
// seguro (evita injecao de cabecalho/log).
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header('x-request-id')
  const requestId = provided && SAFE_ID.test(provided) ? provided : uuidv4()
  res.locals['requestId'] = requestId
  res.setHeader('x-request-id', requestId)
  next()
}
