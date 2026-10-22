import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'
import { ApiError } from '../exceptions/ApiError.ts'

function isZodError(error: unknown): error is ZodError {
  return error instanceof ZodError
}

// Middleware global de erros — ultimo da cadeia.
export function errorMiddleware(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof ApiError) {
    res.status(error.statusCode).json({
      success: false,
      code: error.code,
      message: error.message,
      ...(error.details !== null ? { errors: error.details } : {}),
    })
    return
  }

  if (isZodError(error)) {
    res.status(400).json({
      success: false,
      code: 'PACK_INVALID',
      message: 'Invalid payload',
      errors: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    })
    return
  }

  if (typeof error === 'object' && error !== null) {
    const status = Number(
      (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode,
    )
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      res.status(status).json({
        success: false,
        code: status === 413 ? 'PACK_TOO_LARGE' : 'VALIDATION_ERROR',
        message: status === 413 ? 'Payload too large' : 'Invalid request payload',
      })
      return
    }
  }

  const message = error instanceof Error ? error.message : String(error)
  console.error('[Error] Unhandled error:', message)
  res.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    message: 'Internal server error',
  })
}
