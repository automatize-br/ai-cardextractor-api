// ============================================================================
// Recorte genérico do HTML — agora no EXTRACTOR (contrato v2).
//
// Remove `<style>`, `<svg>`, comentários e data-URIs. Scripts só sobrevivem
// quando são JSON-LD/JSON ou estado conhecido. Nunca trunca no meio do HTML.
// ============================================================================

export const TRIMMER_VERSION = 'trim@1'

export interface TrimResult {
  html: string
  bytes: number
  originalBytes: number
  tooLarge: boolean
}

const SCRIPT_STATE_MARKERS = [
  '__INITIAL_STATE__',
  '__NEXT_DATA__',
  '__PRELOADED_STATE__',
  'window.__',
  // AliExpress: catálogo em scripts de estado (não são JSON-LD).
  '_dida_config_',
  '__AER_DATA__',
  '_init_data_',
  'window._dida',
]

function keepScript(attributes: string, body: string): boolean {
  const attrs = attributes.toLowerCase()
  if (attrs.includes('application/ld+json') || attrs.includes('application/json')) return true
  return SCRIPT_STATE_MARKERS.some((marker) => body.includes(marker))
}

export function trimHtmlForExtraction(html: string, maxBytes: number): TrimResult {
  const originalBytes = Buffer.byteLength(html, 'utf8')
  let output = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/\s(?:src|href|srcset|data-src)="data:[^"]*"/gi, '')

  output = output.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (match, attributes: string, body: string) =>
    keepScript(attributes, body) ? match : '',
  )

  const bytes = Buffer.byteLength(output, 'utf8')
  return { html: output, bytes, originalBytes, tooLarge: bytes > maxBytes }
}
