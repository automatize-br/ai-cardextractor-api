// ============================================================================
// ApiError — erro de negocio com HTTP status + codigo estruturado.
// O errorMiddleware converte em: { success: false, code, message, errors? }
// ============================================================================

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHENTICATION_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PACK_INVALID'
  | 'PACK_TOO_LARGE'
  | 'UNKNOWN_PROFILE'
  | 'INPUT_INVALID'
  | 'PROFILE_MISCONFIGURED'
  | 'MODEL_DISABLED'
  | 'HTML_TOO_LARGE'
  | 'HTML_INVALID'
  | 'CONTRACT_MISMATCH'
  | 'EXTRACTOR_BUSY'
  | 'NO_CARDS_EXTRACTED'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_TIMEOUT'
  | 'AI_PROVIDER_ERROR'
  | 'INTERNAL_ERROR'

export class ApiError extends Error {
  readonly statusCode: number
  readonly code: ApiErrorCode
  readonly details: unknown

  constructor(statusCode: number, code: ApiErrorCode, message: string, details: unknown = null) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }

  static badRequest(message: string, code: ApiErrorCode = 'VALIDATION_ERROR', details: unknown = null): ApiError {
    return new ApiError(400, code, message, details)
  }

  static unauthorized(message = 'Authentication required'): ApiError {
    return new ApiError(401, 'AUTHENTICATION_REQUIRED', message)
  }

  static forbidden(message = 'Access denied.'): ApiError {
    return new ApiError(403, 'FORBIDDEN', message)
  }

  static notFound(message = 'Resource not found'): ApiError {
    return new ApiError(404, 'NOT_FOUND', message)
  }

  static conflict(message: string): ApiError {
    return new ApiError(409, 'CONFLICT', message)
  }

  static tooManyRequests(message = 'Too many requests. Try again later.'): ApiError {
    return new ApiError(429, 'RATE_LIMITED', message)
  }

  static modelUnavailable(message = 'Model unavailable'): ApiError {
    return new ApiError(503, 'MODEL_UNAVAILABLE', message)
  }

  static unknownProfile(message = 'Unknown profile'): ApiError {
    return new ApiError(404, 'UNKNOWN_PROFILE', message)
  }

  static inputInvalid(message = 'Invalid input', details: unknown = null): ApiError {
    return new ApiError(400, 'INPUT_INVALID', message, details)
  }

  static profileMisconfigured(message = 'Profile misconfigured'): ApiError {
    return new ApiError(500, 'PROFILE_MISCONFIGURED', message)
  }

  static modelDisabled(message = 'Model disabled'): ApiError {
    return new ApiError(503, 'MODEL_DISABLED', message)
  }

  static internal(message = 'Internal server error'): ApiError {
    return new ApiError(500, 'INTERNAL_ERROR', message)
  }
}
