import { parse, type HTMLElement } from 'node-html-parser'

// ============================================================================
// Extração determinística de cards a partir de HTML já obtido.
//
// Estratégia: JSON-LD primeiro (quando existe), depois DOM por plataforma e
// fallback estrutural. Nenhum script é executado; nenhum valor é inventado.
// ============================================================================

function parsePriceToCents(raw: string | null | undefined): number | null {
  if (!raw) return null
  const text = raw.replace(/\u00a0/g, ' ').trim()
  const us = /(?<![\d.,-])(\d{1,3}(?:,\d{3})+\.\d{1,2})/.exec(text)
  if (us?.[1]) {
    const value = Number(us[1].replace(/,/g, ''))
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null
  }
  const brThousands = /(?<![.,\d-])(\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?/.exec(text)
  if (brThousands?.[1]) {
    const value = Number(brThousands[1].replace(/\./g, '') + (brThousands[2] ? `.${brThousands[2]}` : ''))
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null
  }
  const commaDecimal = /(?<![.,\d-])(\d+),(\d{1,2})/.exec(text)
  if (commaDecimal?.[1]) {
    const value = Number(`${commaDecimal[1]}.${commaDecimal[2]}`)
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null
  }
  const dotDecimal = /(?<![.,\d-])(\d+)\.(\d{1,2})/.exec(text)
  if (dotDecimal?.[1]) {
    const value = Number(`${dotDecimal[1]}.${dotDecimal[2]}`)
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null
  }
  const integer = /(?<![.,\d-])(\d+)/.exec(text)
  if (!integer?.[1]) return null
  const value = Number(integer[1])
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : null
}

function absoluteUrl(raw: string | undefined | null, base: string): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function externalIdFromUrl(raw: string, marketplace: string): string | null {
  const patterns: Record<string, RegExp[]> = {
    amazon: [/\/dp\/([A-Z0-9]{10})/i, /\/gp\/product\/([A-Z0-9]{10})/i],
    mercadolivre: [/(MLB-?\d+)/i, /\/p\/(MLB\d+)/i],
    shopee: [/-i\.(\d+)\.(\d+)/i, /\/product\/(\d+)/i],
    aliexpress: [/\/item\/(\d+)/i],
    shein: [/\/p-(\d+)/i],
  }
  for (const pattern of patterns[marketplace] ?? []) {
    const match = pattern.exec(raw)
    if (match?.[1]) return match[1]
  }
  return null
}

function textOf(element: HTMLElement | null): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function attrOf(element: HTMLElement | null, name: string): string | null {
  return element?.getAttribute(name) ?? null
}

function imageOf(card: HTMLElement, selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    const image = card.querySelector(selector)
    if (!image) continue
    // A `src` pode ser um data-URI/placeholder; tenta os atributos lazy e o
    // JSON de imagens dinâmicas da Amazon antes de desistir do seletor.
    const dynamic = attrOf(image, 'data-a-dynamic-image')
    let dynamicUrl: string | null = null
    if (dynamic) {
      try {
        const parsed = JSON.parse(dynamic) as Record<string, unknown>
        dynamicUrl = Object.keys(parsed)[0] ?? null
      } catch {
        dynamicUrl = null
      }
    }
    const raw =
      attrOf(image, 'src') ??
      attrOf(image, 'data-src') ??
      attrOf(image, 'data-lazy-src') ??
      attrOf(image, 'data-old-hires') ??
      dynamicUrl ??
      attrOf(image, 'srcset')?.split(/\s+/)[0] ??
      null
    if (raw && !raw.startsWith('data:')) return raw
    const srcset = attrOf(image, 'srcset')?.split(/\s+/).find((item) => item.startsWith('http')) ?? null
    if (srcset) return srcset
    const lazy = attrOf(image, 'data-src') ?? attrOf(image, 'data-lazy-src') ?? attrOf(image, 'data-old-hires')
    if (lazy && !lazy.startsWith('data:')) return lazy
  }
  return null
}

interface PriceCandidate {
  /** Texto usado para parsear (fração+centavos reconstruídos no ML). */
  text: string
  /** Texto VERBATIM do DOM (evidência; pode não ter vírgula). */
  quote: string
  cents: number
}

/** Usa o PRIMEIRO seletor que casar (evita somar fração + preço completo). */
function priceCandidatesOf(card: HTMLElement, selectors: readonly string[]): PriceCandidate[] {
  // Mercado Livre separa fração e centavos em spans (o textContent perde a
  // vírgula: "R$19990"). Reconstrói "199,90" para o parse, mas guarda o texto
  // VERBATIM do elemento como evidência.
  const amountNodes = card.querySelectorAll('.andes-money-amount')
  if (amountNodes.length > 0) {
    const out: PriceCandidate[] = []
    for (const amount of amountNodes) {
      const fraction = textOf(amount.querySelector('.andes-money-amount__fraction'))
      const centsText = textOf(amount.querySelector('.andes-money-amount__cents'))
      const digits = fraction.replace(/\D/g, '')
      if (digits === '') continue
      const text = centsText.replace(/\D/g, '') === ''
        ? digits
        : `${digits},${centsText.replace(/\D/g, '').padStart(2, '0')}`
      const cents = parsePriceToCents(text)
      if (cents === null) continue
      out.push({ text, quote: textOf(amount), cents })
    }
    if (out.length > 0) return out
  }
  for (const selector of selectors) {
    const out: PriceCandidate[] = []
    for (const element of card.querySelectorAll(selector)) {
      const text = textOf(element)
      const cents = parsePriceToCents(text)
      if (text !== '' && cents !== null) out.push({ text, quote: text, cents })
    }
    if (out.length > 0) return out
  }
  return []
}

function titleOf(card: HTMLElement, anchor: HTMLElement, selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    const text = textOf(card.querySelector(selector))
    if (text.length >= 8) return text
  }
  const imageAlt = textOf(card.querySelector('img'))
  if (imageAlt.length >= 8) return imageAlt
  const anchorText = textOf(anchor)
  return anchorText.length >= 8 ? anchorText : null
}

function closestCard(anchor: HTMLElement): HTMLElement {
  let current: HTMLElement | null = anchor
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const hasImage = current.querySelector('img') !== null
    const text = textOf(current)
    const hasPrice = /R\$|US\$|\$/.test(text)
    if (hasImage && hasPrice && text.length > 20) return current
    current = current.parentNode as HTMLElement | null
  }
  return (anchor.parentNode as HTMLElement | null) ?? anchor
}

interface PlatformDomProfile {
  anchorSelectors: string[]
  titleSelectors: string[]
  priceSelectors: string[]
  imageSelectors: string[]
}

const DOM_PROFILES: Record<string, PlatformDomProfile> = {
  amazon: {
    anchorSelectors: ['a[href*="/dp/"]', 'a[href*="/gp/product/"]'],
    titleSelectors: ['h2', '[data-cy="title-recipe"]', '.a-size-base-plus', '.a-size-medium'],
    priceSelectors: ['.a-price .a-offscreen', '.a-offscreen', '.a-price-whole'],
    imageSelectors: ['img.s-image', 'img'],
  },
  mercadolivre: {
    anchorSelectors: ['a[href*="/MLB"]', 'a[href*="/p/MLB"]', 'a.poly-component__title'],
    titleSelectors: ['h2', '.poly-component__title', '.ui-search-item__title'],
    // O preço COMPLETO (fração + centavos) vem antes da fração isolada.
    priceSelectors: ['.andes-money-amount', '.price-tag', '.andes-money-amount__fraction', '.price-tag-fraction'],
    imageSelectors: ['img.poly-component__picture', 'img.ui-search-result-image__element', 'img'],
  },
  shopee: {
    anchorSelectors: ['a[href*="-i."]', 'a[href*="/product/"]'],
    titleSelectors: ['.line-clamp-2', '[data-sqe="name"]', '.ie3A\\+n'],
    priceSelectors: ['[data-sqe="price"]', '.ZEgDH9', '.truncate'],
    imageSelectors: ['img[data-sqe="img"]', 'img'],
  },
  aliexpress: {
    anchorSelectors: ['a[href*="/item/"]'],
    titleSelectors: ['h3', '.multi--titleText--nXeOvyr'],
    priceSelectors: ['.multi--price-sale--U-S0Mh', '.product-price-value'],
    imageSelectors: ['img.multi--image--1gX1N3y', 'img'],
  },
  shein: {
    anchorSelectors: ['a[href*="/p-"]'],
    titleSelectors: ['.product-title', '.goods-title', 'h3'],
    priceSelectors: ['.product-price', '.goods-price', '.price'],
    imageSelectors: ['img.product-image', 'img'],
  },
}

const GENERIC_PROFILE: PlatformDomProfile = {
  anchorSelectors: ['a[href]'],
  titleSelectors: ['h2', 'h3', '[class*="title"]', '[class*="name"]'],
  priceSelectors: ['[class*="price"]', '[class*="preco"]', '[class*="amount"]'],
  imageSelectors: ['img'],
}

interface RawCard {
  externalProductId: string | null
  permalink: string
  title: string
  priceCents: number
  currency: string
  originalPriceCents: number | null
  imageUrl: string
  titleQuote: string
  priceQuote: string
  imageQuote: string
  source: 'jsonld' | 'dom'
  cardRootSelector: string
}

function currencyOf(text: string): string {
  if (/US\$|\$/.test(text) && !/R\$/.test(text)) return 'USD'
  return 'BRL'
}

function cardsFromJsonLd(html: string, base: string, marketplace: string): RawCard[] {
  const root = parse(html)
  const cards: RawCard[] = []
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(script.textContent ?? '')
    } catch {
      continue
    }
    const nodes = Array.isArray(parsed) ? parsed : [parsed]
    const queue = [...nodes]
    while (queue.length > 0) {
      const node = queue.shift()
      if (typeof node !== 'object' || node === null) continue
      const record = node as Record<string, unknown>
      if (Array.isArray(record['@graph'])) queue.push(...record['@graph'])
      const type = record['@type']
      const types = Array.isArray(type) ? type : [type]
      if (!types.includes('Product')) continue
      const title = typeof record['name'] === 'string' ? record['name'].trim() : ''
      const url = typeof record['url'] === 'string' ? record['url'] : typeof record['@id'] === 'string' ? record['@id'] : ''
      const images = record['image']
      const imageRaw = typeof images === 'string'
        ? images
        : Array.isArray(images) && typeof images[0] === 'string'
          ? images[0]
          : typeof images === 'object' && images !== null && typeof (images as Record<string, unknown>)['url'] === 'string'
            ? String((images as Record<string, unknown>)['url'])
            : ''
      const offersRaw = record['offers']
      const offers = Array.isArray(offersRaw) ? offersRaw : [offersRaw]
      for (const offer of offers) {
        if (typeof offer !== 'object' || offer === null) continue
        const priceRaw = (offer as Record<string, unknown>)['price']
        const currency = typeof (offer as Record<string, unknown>)['priceCurrency'] === 'string'
          ? String((offer as Record<string, unknown>)['priceCurrency'])
          : 'BRL'
        const priceText = typeof priceRaw === 'number' ? String(priceRaw) : typeof priceRaw === 'string' ? priceRaw : ''
        const priceCents = parsePriceToCents(priceText)
        const permalink = absoluteUrl(url, base)
        const imageUrl = absoluteUrl(imageRaw, base)
        if (!title || title.length < 8 || priceCents === null || !permalink || !imageUrl) continue
        cards.push({
          externalProductId: typeof record['sku'] === 'string' ? record['sku'] : externalIdFromUrl(permalink, marketplace),
          permalink,
          title,
          priceCents,
          currency,
          originalPriceCents: null,
          imageUrl,
          titleQuote: title,
          priceQuote: priceText,
          imageQuote: imageRaw,
          source: 'jsonld',
          cardRootSelector: `a[href="${permalink.replace(/"/g, '\\"')}"]`,
        })
      }
    }
  }
  return cards
}

function cardsFromDom(html: string, base: string, marketplace: string, maxScanned: number): RawCard[] {
  const root = parse(html)
  const profile = DOM_PROFILES[marketplace] ?? GENERIC_PROFILE
  const cards: RawCard[] = []
  const seen = new Set<string>()

  for (const selector of profile.anchorSelectors) {
    for (const anchor of root.querySelectorAll(selector)) {
      if (cards.length >= maxScanned) return cards
      const href = attrOf(anchor, 'href')
      const permalink = absoluteUrl(href, base)
      if (!permalink) continue
      if (seen.has(permalink)) continue
      seen.add(permalink)

      const card = closestCard(anchor)
      const title = titleOf(card, anchor, profile.titleSelectors)
      const priceCandidates = priceCandidatesOf(card, profile.priceSelectors)
      if (!title || priceCandidates.length === 0) continue
      const currentPrice = [...priceCandidates].sort((left, right) => left.cents - right.cents)[0]
      if (!currentPrice) continue
      const original =
        [...priceCandidates]
          .map((candidate) => candidate.cents)
          .filter((cents) => cents > currentPrice.cents)
          .sort((left, right) => right - left)[0] ?? null
      const imageRaw = imageOf(card, profile.imageSelectors)
      const imageUrl = absoluteUrl(imageRaw, base)
      if (!imageUrl) continue
      const currency = currencyOf(currentPrice.text)

      cards.push({
        externalProductId: externalIdFromUrl(permalink, marketplace),
        permalink,
        title: title.slice(0, 300),
        priceCents: currentPrice.cents,
        currency,
        originalPriceCents: original,
        imageUrl,
        titleQuote: title,
        priceQuote: currentPrice.quote,
        imageQuote: imageRaw ?? imageUrl,
        source: 'dom',
        cardRootSelector: `a[href="${permalink.replace(/"/g, '\\"')}"]`,
      })
    }
  }
  return cards
}

export function extractRawCards(
  html: string,
  marketplace: string,
  baseUrl: string,
  maxScanned: number,
): { cards: RawCard[]; truncated: boolean } {
  const jsonLd = cardsFromJsonLd(html, baseUrl, marketplace)
  // JSON-LD costuma descrever a LISTAGEM inteira; quando traz poucos itens
  // (ex.: só o produto principal), o DOM complementa a cobertura.
  const dom = jsonLd.length >= 3 ? [] : cardsFromDom(html, baseUrl, marketplace, maxScanned)
  const all = [...jsonLd, ...dom]
  const seen = new Set<string>()
  const unique: RawCard[] = []
  for (const card of all) {
    const key = card.externalProductId ?? card.permalink
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(card)
    if (unique.length >= maxScanned) break
  }
  return { cards: unique, truncated: all.length >= maxScanned }
}

export { parsePriceToCents }
export type { RawCard }
