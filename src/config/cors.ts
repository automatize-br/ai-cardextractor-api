import { env } from './env.ts'

// ============================================================================
// CORS restrito. Vazio = nenhuma origem de browser liberada (server-to-server
// nao envia Origin e continua funcionando). Nunca usar "*".
// ============================================================================

export function corsOriginCallback(
  origin: string | undefined,
  callback: (error: Error | null, allow?: boolean) => void,
): void {
  if (!origin) {
    callback(null, true)
    return
  }
  callback(null, env.CORS_ORIGINS.includes(origin))
}
