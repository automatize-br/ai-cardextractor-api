// ============================================================================
// Hosts aceitos na coleta feita PELO EXTRACTOR (contrato v2).
// Espelha o allowlist anti-SSRF da API para as 5 plataformas suportadas.
// ============================================================================

export const SCRAPE_MARKETPLACES = ['amazon', 'mercadolivre', 'shopee', 'aliexpress', 'shein'] as const
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
