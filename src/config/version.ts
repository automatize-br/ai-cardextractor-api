import { env } from './env.ts'

// Versões do contrato compartilhadas por heartbeat e resposta de extração.
// `contractVersion` só muda com quebra de gramática; `coreVersion` é major.
export const CONTRACT_VERSION = '1'
// Contrato de OFERTAS (o que a API consome): v2 = extractor busca/extrai/revalida.
export const OFFERS_CONTRACT_VERSION = '2'
export const EXTRACTOR_VERSION = env.EXTRACTOR_VERSION.trim() === '' ? 'dev' : env.EXTRACTOR_VERSION
export const CORE_VERSION = `offer-extract-core@${EXTRACTOR_VERSION}`

/** Major do core; compatibilidade é por major, nunca por string literal. */
export function coreMajorOf(coreVersion: string): number {
  const raw = coreVersion.split('@')[1] ?? ''
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

export const CORE_MAJOR = coreMajorOf(CORE_VERSION)

export const SUPPORTED_PLATFORMS = [
  'amazon',
  'mercadolivre',
  'shopee',
  'aliexpress',
  'shein',
  'temu',
  'tiktokshop',
  'magalu',
  'netshoes',
  'casasbahia',
  'pontofrio',
  'americanas',
  'kabum',
  'centauro',
  'renner',
  'riachuelo',
  'dafiti',
  'zattini',
  'boticario',
] as const

// Plataformas que só funcionam com Chromium. O worker não embarca browser
// (Etapa E decide), então elas ficam fora da capability publicada.
export const BROWSER_ONLY_PLATFORMS = ['shopee'] as const

/**
 * Capability efetiva do worker: só entra o que ele consegue executar hoje.
 * `EXTRACTOR_PLATFORMS` explícito é respeitado, mas JS-only é filtrado enquanto
 * `WORKER_BROWSER_ENABLED=false`.
 */
export function workerCapabilities(platforms: string[], browserEnabled: boolean): string[] {
  const unique = [...new Set(platforms.map((item) => item.trim().toLowerCase()).filter(Boolean))]
  if (browserEnabled) return unique
  return unique.filter((item) => !BROWSER_ONLY_PLATFORMS.includes(item as never))
}
