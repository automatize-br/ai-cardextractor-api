import { env } from '../../config/env.ts'
import { FakeVisionProvider } from './fakeVisionProvider.ts'
import { HttpVisionProvider } from './httpVisionProvider.ts'
import type { VisionProvider } from './types.ts'

// ============================================================================
// Registro do provider de visao. `VISION_PROVIDER` e lido a CADA request para
// permitir desligar a visao em runtime (kill switch), sem reiniciar o servico.
// ============================================================================

export type VisionProviderName = 'off' | 'fake' | 'http'

export function getVisionProviderName(): VisionProviderName {
  const value = (process.env['VISION_PROVIDER'] ?? 'off').trim().toLowerCase()
  if (value === 'http' || value === 'fake') return value
  return 'off'
}

let fake: FakeVisionProvider | null = null
let http: HttpVisionProvider | null = null
let httpKey = ''

export function getVisionProvider(): VisionProvider | null {
  const name = getVisionProviderName()
  if (name === 'off') return null
  if (name === 'fake') {
    fake ??= new FakeVisionProvider()
    return fake
  }
  if (env.VISION_HTTP_URL === '') return null
  const key = `${env.VISION_HTTP_URL}\u0000${env.VISION_HTTP_API_KEY}`
  if (!http || httpKey !== key) {
    http = new HttpVisionProvider(env.VISION_HTTP_URL, env.VISION_HTTP_API_KEY)
    httpKey = key
  }
  return http
}

/** Reset deterministico para testes (instancias em cache). */
export function resetVisionProvidersForTests(): void {
  fake = null
  http = null
  httpKey = ''
}

export { FakeVisionProvider, HttpVisionProvider }
export type { VisionProvider, VisionScoreInput } from './types.ts'
