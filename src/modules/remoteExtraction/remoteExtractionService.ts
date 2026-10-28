import { env } from '../../config/env.ts'
import { isScrapeMarketplace } from '../../config/marketplaces.ts'
import { ApiError } from '../../exceptions/ApiError.ts'
import ExtractionService from '../extraction/extractionService.ts'
import { fetchPageHtml, ScrapeFetchError, type FetchedPage } from './pageFetcher.ts'
import { trimHtmlForExtraction } from './htmlTrimmer.ts'
import { emptyDiscarded, revalidateCards, type DiscardedCounters, type RemoteOffer } from './revalidate.ts'

// ============================================================================
// Extração COMPLETA no extractor (contrato v2): busca, recorta, extrai e
// revalida. A API envia apenas plataforma + URLs + parâmetros.
// ============================================================================

export type RemoteQuality = 'ok' | 'partial' | 'no_cards' | 'blocked' | 'unavailable'

export interface RemoteExtractionInput {
  marketplace: string
  urls: string[]
  query?: string
  profile: string
  mode: string
  maxScanned: number
  maxCards: number
  maxLlmCards: number
  deadlineAt: number
}

export interface SourceResult {
  url: string
  source: FetchedPage['source'] | null
  bytes: number
  ms: number
  cards: number
  offers: number
  rejected: number
  error: string | null
}

export interface RemoteExtractionResult {
  marketplace: string
  offers: RemoteOffer[]
  discarded: DiscardedCounters
  rejected: number
  quality: RemoteQuality
  reason: string | null
  scanned: number
  sources: SourceResult[]
  durationMs: number
}

export interface RemoteDeps {
  fetchPage?: (url: string, marketplace: string) => Promise<FetchedPage>
  extract?: typeof ExtractionService.extract
}

function mergeCounters(target: DiscardedCounters, source: DiscardedCounters): void {
  for (const key of Object.keys(target) as Array<keyof DiscardedCounters>) {
    target[key] += source[key]
  }
}

function dedupe(offers: RemoteOffer[]): RemoteOffer[] {
  const seen = new Set<string>()
  const result: RemoteOffer[] = []
  for (const offer of offers) {
    const key = offer.externalProductId || offer.permalink
    if (seen.has(key)) continue
    seen.add(key)
    result.push(offer)
  }
  return result
}

function qualityOf(offers: number, sources: SourceResult[]): RemoteQuality {
  if (offers > 0) return sources.some((source) => source.error !== null) ? 'partial' : 'ok'
  if (sources.some((source) => source.error === 'blocked')) return 'blocked'
  if (sources.some((source) => source.error === 'unavailable')) return 'unavailable'
  return 'no_cards'
}

const REASONS: Record<RemoteQuality, string | null> = {
  ok: null,
  partial: 'PARTIAL_SOURCES',
  no_cards: 'NO_CARDS_EXTRACTED',
  blocked: 'SCRAPE_BLOCKED',
  unavailable: 'SOURCE_UNAVAILABLE',
}

export default class RemoteExtractionService {
  static async extract(input: RemoteExtractionInput, deps: RemoteDeps = {}): Promise<RemoteExtractionResult> {
    const startedAt = Date.now()
    if (!isScrapeMarketplace(input.marketplace)) {
      throw new ApiError(400, 'INPUT_INVALID', `marketplace não suportado: ${input.marketplace}`)
    }
    if (input.urls.length === 0 || input.urls.length > 5) {
      throw new ApiError(400, 'INPUT_INVALID', 'urls deve ter entre 1 e 5 itens')
    }

    const fetchPage = deps.fetchPage ?? fetchPageHtml
    const extract = deps.extract ?? ExtractionService.extract
    const discarded = emptyDiscarded()
    const sources: SourceResult[] = []
    const collected: RemoteOffer[] = []
    let rejected = 0
    let scanned = 0

    for (const url of input.urls) {
      if (Date.now() >= input.deadlineAt) break
      const sourceStartedAt = Date.now()
      try {
        const page = await fetchPage(url, input.marketplace)
        const trimmed = trimHtmlForExtraction(page.html, env.EXTRACTOR_MAX_HTML_BYTES)
        if (trimmed.tooLarge) {
          sources.push({
            url,
            source: page.source,
            bytes: page.bytes,
            ms: Date.now() - sourceStartedAt,
            cards: 0,
            offers: 0,
            rejected: 0,
            error: 'html_too_large_after_trim',
          })
          continue
        }
        const result = await extract({
          marketplace: input.marketplace,
          url,
          html: trimmed.html,
          profile: input.profile,
          maxScanned: input.maxScanned,
          maxCards: input.maxCards,
          maxLlmCards: input.maxLlmCards,
          mode: input.mode,
        })
        const validated = revalidateCards(result.cards, trimmed.html, input.marketplace)
        mergeCounters(discarded, validated.discarded)
        collected.push(...validated.offers)
        rejected += validated.rejected
        scanned += result.scanned
        sources.push({
          url,
          source: page.source,
          bytes: page.bytes,
          ms: Date.now() - sourceStartedAt,
          cards: result.cards.length,
          offers: validated.offers.length,
          rejected: validated.rejected,
          error: null,
        })
      } catch (error) {
        const kind = error instanceof ScrapeFetchError ? error.kind : 'unavailable'
        if (!(error instanceof ScrapeFetchError) && !(error instanceof ApiError)) {
          console.warn('[extract-offers] fonte falhou:', error instanceof Error ? error.message : error)
        }
        sources.push({
          url,
          source: null,
          bytes: 0,
          ms: Date.now() - sourceStartedAt,
          cards: 0,
          offers: 0,
          rejected: 0,
          error: kind,
        })
      }
    }

    const offers = dedupe(collected)
    const quality = qualityOf(offers.length, sources)
    return {
      marketplace: input.marketplace,
      offers,
      discarded,
      rejected,
      quality,
      reason: REASONS[quality],
      scanned,
      sources,
      durationMs: Date.now() - startedAt,
    }
  }
}
