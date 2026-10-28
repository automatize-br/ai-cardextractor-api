import { isIP } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { env, isProductionEnvironment } from '../../config/env.ts'
import { isMarketplaceHost } from '../../config/marketplaces.ts'

// ============================================================================
// Coleta da página no PRÓPRIO extractor.
//
// Cascata: UNBLOCKER (Decodo/equivalente, já entrega HTML renderizado) → fetch
// direto (com proxy opcional). Nada disso passa pela API central: é o trabalho
// pesado que motivou o pool. Configuração por instância:
//   SCRAPE_UNBLOCKER_AUTH / SCRAPE_UNBLOCKER_URL
//   SCRAPE_PROXY_URL
// ============================================================================

export type FetchSource = 'unblocker' | 'proxy' | 'http'
export type FetchFailure = 'blocked' | 'unavailable' | 'rejected'

export class ScrapeFetchError extends Error {
  constructor(
    message: string,
    readonly kind: FetchFailure,
  ) {
    super(message)
    this.name = 'ScrapeFetchError'
  }
}

export interface FetchedPage {
  html: string
  source: FetchSource
  bytes: number
  ms: number
}

const CHALLENGE_MARKERS = [
  /account[-_ ]verification/i,
  /suspicious[-_ ]traffic/i,
  /captcha-delivery\.com/i,
  /geo\.captcha/i,
  /verify you are human/i,
  /unusual traffic/i,
  /robot check/i,
  /digite os caracteres/i,
  /access denied/i,
]

const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

export function looksLikeChallenge(html: string): boolean {
  const head = html.slice(0, 200_000)
  return CHALLENGE_MARKERS.some((marker) => marker.test(head))
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const version = isIP(host)
  if (version === 4) {
    const [a = 0, b = 0] = host.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  if (version === 6) {
    return host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')
  }
  return false
}

/** Valida a URL de coleta: protocolo, credenciais, host da plataforma e SSRF. */
export function assertScrapeUrl(raw: string, marketplace: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ScrapeFetchError('URL de coleta inválida', 'rejected')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ScrapeFetchError('URL de coleta deve usar http ou https', 'rejected')
  }
  if (url.username !== '' || url.password !== '') {
    throw new ScrapeFetchError('URL de coleta não pode conter credenciais', 'rejected')
  }
  if (isPrivateHost(url.hostname) && !env.EXTRACTOR_ALLOW_PRIVATE_SCRAPE) {
    throw new ScrapeFetchError('URL de coleta aponta para endereço privado', 'rejected')
  }
  if (isProductionEnvironment() && url.protocol !== 'https:') {
    throw new ScrapeFetchError('URL de coleta deve usar HTTPS em produção', 'rejected')
  }
  if (!isMarketplaceHost(marketplace, url.hostname)) {
    throw new ScrapeFetchError(`Host ${url.hostname} não pertence a ${marketplace}`, 'rejected')
  }
  return url
}

function unblockerConfig(): { url: string; authorization: string; geo: string } | null {
  const auth = env.SCRAPE_UNBLOCKER_AUTH.trim()
  if (auth === '') return null
  let authorization = auth
  if (!/^(Basic|Bearer)\s/i.test(auth)) {
    authorization = auth.includes(':') ? `Basic ${Buffer.from(auth).toString('base64')}` : `Bearer ${auth}`
  }
  return {
    url: env.SCRAPE_UNBLOCKER_URL.trim() || 'https://data.decodo.com/v1/scrape',
    authorization,
    geo: env.SCRAPE_UNBLOCKER_GEO.trim().toLowerCase(),
  }
}

/** Extrai o HTML da resposta do unblocker (JSON `{content}` ou HTML direto). */
function parseUnblockerBody(text: string): string | null {
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    const results = Array.isArray(json['results']) ? (json['results'] as Array<Record<string, unknown>>) : []
    const candidate = results[0]?.['content'] ?? json['content'] ?? json['html'] ?? json['body'] ?? json['data']
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
  } catch {
    return text.length > 0 ? text : null
  }
}

async function fetchWithUnblocker(target: string, marketplace: string): Promise<string | null> {
  const config = unblockerConfig()
  if (!config) return null
  try {
    const response = await undiciFetch(config.url, {
      method: 'POST',
      headers: {
        authorization: config.authorization,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        url: target,
        headless: 'html',
        device_type: 'desktop',
        // AliExpress é global: sem geo o preço vem em USD/CAD/MXN. Só enviamos
        // geo para ele; os domínios .com.br recusariam o parâmetro.
        ...(config.geo !== '' && marketplace === 'aliexpress' ? { geo: config.geo } : {}),
      }),
      signal: AbortSignal.timeout(env.SCRAPE_UNBLOCKER_TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) {
      console.warn(`[scrape] unblocker HTTP ${response.status}`)
      return null
    }
    return parseUnblockerBody(text)
  } catch (error) {
    console.warn('[scrape] unblocker falhou:', error instanceof Error ? error.message : error)
    return null
  }
}

let proxyDispatcher: ProxyAgent | null = null

function getProxyDispatcher(): ProxyAgent | null {
  const proxy = env.SCRAPE_PROXY_URL.trim()
  if (proxy === '') return null
  if (!proxyDispatcher) proxyDispatcher = new ProxyAgent(proxy)
  return proxyDispatcher
}

async function fetchDirect(target: string): Promise<string | null> {
  const dispatcher = getProxyDispatcher()
  try {
    const response = await undiciFetch(target, {
      method: 'GET',
      headers: BROWSER_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(env.SCRAPE_FETCH_TIMEOUT_MS),
      ...(dispatcher ? { dispatcher } : {}),
    })
    const contentLength = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(contentLength) && contentLength > env.EXTRACTOR_SCRAPE_MAX_BYTES) {
      throw new ScrapeFetchError('Página excede o limite de bytes', 'unavailable')
    }
    const text = await response.text()
    if (!response.ok) {
      console.warn(`[scrape] HTTP ${response.status} em ${new URL(target).hostname}`)
      return null
    }
    return text
  } catch (error) {
    if (error instanceof ScrapeFetchError) throw error
    console.warn('[scrape] fetch falhou:', error instanceof Error ? error.message : error)
    return null
  }
}

/**
 * Busca o HTML da página. Tenta o unblocker e, se ele não estiver configurado
 * ou falhar, o fetch direto (com proxy quando configurado).
 */
export async function fetchPageHtml(rawUrl: string, marketplace: string): Promise<FetchedPage> {
  const url = assertScrapeUrl(rawUrl, marketplace)
  const startedAt = Date.now()
  const target = url.toString()

  const unblockerHtml = await fetchWithUnblocker(target, marketplace)
  if (unblockerHtml !== null) {
    const page = finish(unblockerHtml, 'unblocker', startedAt)
    dumpHtml(marketplace, page)
    return page
  }
  const directHtml = await fetchDirect(target)
  if (directHtml !== null) {
    const page = finish(directHtml, getProxyDispatcher() ? 'proxy' : 'http', startedAt)
    dumpHtml(marketplace, page)
    return page
  }
  throw new ScrapeFetchError('Nenhuma fonte conseguiu buscar a página', 'unavailable')
}

/** Diagnóstico opt-in: salva o HTML bruto para inspeção de layout. */
function dumpHtml(marketplace: string, page: FetchedPage): void {
  if (!env.SCRAPE_DEBUG_DUMP) return
  try {
    const dir = path.resolve('tmp/scrape')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${Date.now()}-${marketplace}-${page.source}.html`)
    writeFileSync(file, page.html)
    console.log(`[scrape] dump: ${file}`)
  } catch (error) {
    console.warn('[scrape] dump falhou:', error instanceof Error ? error.message : error)
  }
}

function finish(html: string, source: FetchSource, startedAt: number): FetchedPage {
  const bytes = Buffer.byteLength(html, 'utf8')
  if (bytes > env.EXTRACTOR_SCRAPE_MAX_BYTES) {
    throw new ScrapeFetchError('Página excede o limite de bytes', 'unavailable')
  }
  if (looksLikeChallenge(html)) {
    throw new ScrapeFetchError('Página de verificação anti-bot', 'blocked')
  }
  return { html, source, bytes, ms: Date.now() - startedAt }
}

export function resetScrapeProxyForTests(): void {
  proxyDispatcher = null
}
