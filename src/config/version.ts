import { env } from './env.ts'

// Versões do contrato compartilhadas por heartbeat e resposta de extração.
// `contractVersion` só muda com quebra de gramática; `coreVersion` é major.
export const CONTRACT_VERSION = '1'
export const EXTRACTOR_VERSION = env.EXTRACTOR_VERSION.trim() === '' ? 'dev' : env.EXTRACTOR_VERSION
export const CORE_VERSION = `offer-extract-core@${EXTRACTOR_VERSION}`

export const SUPPORTED_PLATFORMS = ['amazon', 'mercadolivre', 'shopee', 'aliexpress', 'shein'] as const
