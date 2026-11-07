// ============================================================================
// Hosts aceitos na coleta feita PELO EXTRACTOR (contrato v2).
// Espelha o allowlist anti-SSRF da API. TODO o scrape de ofertas roda aqui —
// a API principal nunca busca/renderiza HTML (só integrações oficiais por
// chave/senha, ex.: Shopee Open API, ficam nela).
// ============================================================================

// Todas as lojas com coleta por scrape. Shopee fica listada (coleta tecnicamente
// suportada), mas a API a resolve pela integração oficial e o worker filtra
// `BROWSER_ONLY_PLATFORMS` sem browser — na prática o pool não a usa.
export const SCRAPE_MARKETPLACES = [
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
export type ScrapeMarketplace = (typeof SCRAPE_MARKETPLACES)[number]

const AMAZON_DOMAIN = String.raw`amazon\.(?:com(?:\.(?:br|mx|au|tr))?|ca|es|de|fr|it|co\.uk|nl|se|pl|co\.jp|in|sg|ae|sa|eg|be)`

const PATTERNS: Record<ScrapeMarketplace, RegExp[]> = {
  amazon: [
    new RegExp(`^https?://(?:www\\.)?${AMAZON_DOMAIN}/`, 'i'),
    /^https?:\/\/amzn\.(?:to|eu)\//i,
  ],
  mercadolivre: [
    /^https?:\/\/(www\.|produto\.|lista\.)?mercadolivre\.com\.br\//i,
    /^https?:\/\/(www\.)?mercadolivre\.com\//i,
    /^https?:\/\/(www\.)?mercadolibre\.com\//i,
  ],
  shopee: [
    /^https?:\/\/(www\.)?shopee\.com\.br\//i,
    /^https?:\/\/(s|brs)\.shopee\.com\.br\//i,
  ],
  aliexpress: [/^https?:\/\/(?:[\w-]+\.)*aliexpress\.com\//i],
  shein: [/^https?:\/\/(?:[\w-]+\.)*shein\.com(?:\.br)?\//i],
  temu: [/^https?:\/\/(?:[\w-]+\.)*temu\.com\//i],
  // TikTok Shop: o host de loja é shop.tiktok.com; tiktok.com permite os paths
  // de loja/produto (a URL exata vem dos templates da API, não do usuário).
  tiktokshop: [/^https?:\/\/(?:shop\.|www\.)?tiktok\.com\//i],
  magalu: [/^https?:\/\/(www\.)?magazineluiza\.com\.br\//i],
  netshoes: [/^https?:\/\/(www\.)?netshoes\.com\.br\//i],
  casasbahia: [/^https?:\/\/(www\.)?casasbahia\.com\.br\//i],
  pontofrio: [/^https?:\/\/(www\.)?pontofrio\.com\.br\//i],
  americanas: [/^https?:\/\/(www\.)?americanas\.com\.br\//i],
  kabum: [/^https?:\/\/(www\.)?kabum\.com\.br\//i],
  centauro: [/^https?:\/\/(www\.)?centauro\.com\.br\//i],
  renner: [/^https?:\/\/(www\.)?(lojasrenner|renner)\.com\.br\//i],
  riachuelo: [/^https?:\/\/(www\.)?riachuelo\.com\.br\//i],
  dafiti: [/^https?:\/\/(www\.)?dafiti\.com\.br\//i],
  zattini: [/^https?:\/\/(www\.)?zattini\.com\.br\//i],
  boticario: [/^https?:\/\/(www\.)?boticario\.com\.br\//i],
}

export function isScrapeMarketplace(value: string): value is ScrapeMarketplace {
  return (SCRAPE_MARKETPLACES as readonly string[]).includes(value)
}

/** Host pertence à plataforma (anti-SSRF da coleta e da revalidação). */
export function isMarketplaceHost(marketplace: string, hostname: string): boolean {
  if (!isScrapeMarketplace(marketplace)) return false
  const host = hostname.toLowerCase()
  return PATTERNS[marketplace].some((pattern) => pattern.test(`https://${host}/`))
}
