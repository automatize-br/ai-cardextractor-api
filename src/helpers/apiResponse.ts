import type { Response } from 'express'

// Padrao de resposta: { success: true, data, message? } / { success: false, ... }

export function sendSuccess<T>(res: Response, data: T, statusCode = 200, message?: string): Response {
  return res.status(statusCode).json({
    success: true,
    data,
    ...(message !== undefined ? { message } : {}),
  })
}

export function sendError(
  res: Response,
  message: string,
  statusCode = 400,
  code = 'VALIDATION_ERROR',
  errors: unknown = null,
): Response {
  return res.status(statusCode).json({
    success: false,
    code,
    message,
    ...(errors !== null ? { errors } : {}),
  })
}
