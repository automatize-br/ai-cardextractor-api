import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertScrapeUrl, looksLikeChallenge, ScrapeFetchError } from '../../src/modules/remoteExtraction/pageFetcher.ts'
import { trimHtmlForExtraction } from '../../src/modules/remoteExtraction/htmlTrimmer.ts'
import { emptyDiscarded, revalidateCards } from '../../src/modules/remoteExtraction/revalidate.ts'
import RemoteExtractionService from '../../src/modules/remoteExtraction/remoteExtractionService.ts'
import type { ExtractedCard } from '../../src/modules/extraction/types.ts'

const HTML = `<html><body>
  <div class="poly-card">
    <a href="https://produto.mercadolivre.com.br/MLB-123-notebook">Notebook Teste</a>
    <img src="https://http2.mlstatic.com/img.jpg" />
    <span class="price">R$ 1.999,00</span>
  </div>
</body></html>`

function card(overrides: Partial<ExtractedCard> = {}): ExtractedCard {
  return {
    cardId: 'c1',
    externalProductId: 'MLB123',
    permalink: 'https://produto.mercadolivre.com.br/MLB-123-notebook',
    title: 'Notebook Teste',
    priceCents: 199900,
    currency: 'BRL',
    originalPriceCents: null,
    imageUrl: 'https://http2.mlstatic.com/img.jpg',
    candidates: {
      titles: [{ id: 't1', text: 'Notebook Teste' }],
      prices: [{ id: 'p1', cents: 199900, currency: 'BRL', kind: 'current', text: 'R$ 1.999,00' }],
      images: [{ id: 'i1', url: 'https://http2.mlstatic.com/img.jpg' }],
    },
    evidence: {
      cardRoot: { selector: '.poly-card', occurrence: 0 },
      title: { source: 'dom', quote: 'Notebook Teste' },
      price: { source: 'dom', quote: 'R$ 1.999,00' },
      image: { source: 'dom', quote: 'https://http2.mlstatic.com/img.jpg' },
    },
    confidence: 0.9,
    needsReview: false,
    reviewReasons: [],
    ...overrides,
  }
}

test('URL de coleta rejeita host privado e host de outra plataforma', () => {
  assert.throws(() => assertScrapeUrl('http://127.0.0.1/x', 'mercadolivre'), ScrapeFetchError)
  assert.throws(() => assertScrapeUrl('https://evil.example.com/x', 'mercadolivre'), ScrapeFetchError)
  assert.throws(() => assertScrapeUrl('file:///etc/passwd', 'mercadolivre'), ScrapeFetchError)
  const ok = assertScrapeUrl('https://lista.mercadolivre.com.br/notebook', 'mercadolivre')
  assert.equal(ok.hostname, 'lista.mercadolivre.com.br')
})

test('detecta página de verificação anti-bot', () => {
  assert.equal(looksLikeChallenge('<title>Account verification</title>'), true)
  assert.equal(looksLikeChallenge(HTML), false)
})

test('trim remove style/script comum e preserva JSON-LD', () => {
  const html = `<html><head><style>a{}</style><script>var x=1</script>
    <script type="application/ld+json">{"a":1}</script></head><body>ok</body></html>`
  const result = trimHtmlForExtraction(html, 1_000)
  assert.equal(result.tooLarge, false)
  assert.ok(!result.html.includes('<style'))
  assert.ok(!result.html.includes('var x=1'))
  assert.ok(result.html.includes('application/ld+json'))
})

test('trim preserva os scripts de dados do AliExpress', () => {
  const html = `<html><head>
    <script>window._dida_config_={items:[1]}</script>
    <script>window.__AER_DATA__={items:[2]}</script>
    <script>var lixo=1</script>
  </head><body>ok</body></html>`
  const result = trimHtmlForExtraction(html, 10_000)
  assert.ok(result.html.includes('_dida_config_'))
  assert.ok(result.html.includes('__AER_DATA__'))
  assert.ok(!result.html.includes('lixo'))
})

test('revalida card bom e devolve contrato RawOffer', () => {
  const result = revalidateCards([card()], HTML, 'mercadolivre')
  assert.equal(result.rejected, 0)
  assert.equal(result.offers.length, 1)
  assert.equal(result.offers[0]?.price, 199900)
  assert.equal(result.offers[0]?.currency, 'BRL')
  assert.equal(result.offers[0]?.extractionSource, 'pool')
  assert.deepEqual(result.discarded, emptyDiscarded())
})

test('revalida descarta card sem preço, moeda errada e link fora da loja', () => {
  const noPrice = card({ priceCents: 0 })
  const usd = card({ cardId: 'c2', currency: 'USD' })
  const badLink = card({ cardId: 'c3', permalink: 'https://evil.example.com/p/1' })
  const result = revalidateCards([noPrice, usd, badLink], HTML, 'mercadolivre')
  assert.equal(result.offers.length, 0)
  assert.equal(result.discarded.missingPrice, 1)
  assert.equal(result.discarded.currency, 1)
  assert.equal(result.discarded.invalidLink, 1)
  assert.equal(result.rejected, 3)
})

test('evidência que não existe no HTML vira needsReview (não descarta)', () => {
  const result = revalidateCards([card({ title: 'Notebook Teste', evidence: {
    ...card().evidence,
    title: { source: 'dom', quote: 'Título Fabricado' },
  } })], HTML, 'mercadolivre')
  assert.equal(result.offers.length, 1)
  assert.equal(result.offers[0]?.needsReview, true)
  assert.ok(result.offers[0]?.reviewReasons?.includes('evidence_title_mismatch'))
})

test('serviço remoto: uma fonte bloqueada + uma ok = partial com ofertas', async () => {
  const result = await RemoteExtractionService.extract(
    {
      marketplace: 'mercadolivre',
      urls: [
        'https://lista.mercadolivre.com.br/a',
        'https://lista.mercadolivre.com.br/b',
      ],
      profile: 'cards',
      mode: 'off',
      maxScanned: 200,
      maxCards: 200,
      maxLlmCards: 0,
      deadlineAt: Date.now() + 30_000,
    },
    {
      fetchPage: async (url) => {
        if (url.endsWith('/a')) throw new ScrapeFetchError('verificação', 'blocked')
        return { html: HTML, source: 'unblocker', bytes: HTML.length, ms: 1 }
      },
      extract: async () => ({
        marketplace: 'mercadolivre',
        cards: [card()],
        rejected: [],
        scanned: 1,
        truncated: false,
        coverageComplete: true,
        quality: 'ok',
        mode: 'off',
        execution: null,
      }),
    },
  )
  assert.equal(result.quality, 'partial')
  assert.equal(result.offers.length, 1)
  assert.equal(result.sources[0]?.error, 'blocked')
  assert.equal(result.sources[1]?.offers, 1)
})

test('serviço remoto: sem ofertas e sem falha = no_cards', async () => {
  const result = await RemoteExtractionService.extract(
    {
      marketplace: 'mercadolivre',
      urls: ['https://lista.mercadolivre.com.br/a'],
      profile: 'cards',
      mode: 'off',
      maxScanned: 200,
      maxCards: 200,
      maxLlmCards: 0,
      deadlineAt: Date.now() + 30_000,
    },
    {
      fetchPage: async () => ({ html: HTML, source: 'http', bytes: HTML.length, ms: 1 }),
      extract: async () => ({
        marketplace: 'mercadolivre',
        cards: [],
        rejected: [],
        scanned: 0,
        truncated: false,
        coverageComplete: false,
        quality: 'no_cards',
        mode: 'fallback',
        execution: null,
      }),
    },
  )
  assert.equal(result.quality, 'no_cards')
  assert.equal(result.reason, 'NO_CARDS_EXTRACTED')
})
