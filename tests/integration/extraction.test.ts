import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { createApp } from '../../src/app.ts'

const app = createApp()
let server: ReturnType<typeof app.listen>
let baseUrl = ''

const html = `<!doctype html><html><body>
<div class="s-result-item">
  <a href="/Fone-JBL/dp/B0ABCDEFGH/ref=sr_1_1"><h2>Fone Bluetooth JBL Tune 510BT</h2></a>
  <img class="s-image" src="https://m.media-amazon.com/images/I/x.jpg" />
  <span class="a-price"><span class="a-offscreen">R$ 199,90</span></span>
</div>
</body></html>`

function metaFor(body: Buffer, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    marketplace: 'amazon',
    url: 'https://www.amazon.com.br/ofertas',
    profile: 'cards',
    contractVersion: '1',
    coreVersion: 'offer-extract-core@test',
    trimmerVersion: 'trim@1',
    htmlHashTrimmed: createHash('sha256').update(body).digest('hex'),
    htmlBytes: body.length,
    maxScanned: 200,
    maxCards: 200,
    maxLlmCards: 10,
    mode: 'assist',
    deadlineAt: Date.now() + 5000,
    requestId: 'req_extract_1',
    ...overrides,
  })
}

function post(body: Buffer, meta: string, encoding?: 'gzip'): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/extract`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-internal-key': 'test-internal-key',
      'x-extract-meta': meta,
      ...(encoding ? { 'content-encoding': encoding } : {}),
    },
    body,
  })
}

before(async () => {
  server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('/api/v1/extract exige chave interna', async () => {
  const response = await fetch(`${baseUrl}/api/v1/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from(html),
  })
  assert.equal(response.status, 401)
})

test('/api/v1/extract extrai card de HTML com meta válido', async () => {
  const body = Buffer.from(html)
  const response = await post(body, metaFor(body))
  assert.equal(response.status, 200)
  const payload = (await response.json()) as {
    data: { cards: Array<Record<string, unknown>>; diagnostics: Record<string, unknown>; reason: string | null }
  }
  assert.equal(payload.data.cards.length, 1)
  assert.equal(payload.data.cards[0]?.['title'], 'Fone Bluetooth JBL Tune 510BT')
  assert.equal(payload.data.cards[0]?.['priceCents'], 19990)
  assert.equal(payload.data.diagnostics['quality'], 'ok')
  assert.equal(payload.data.reason, null)
})

test('corpo gzip é aceito e descompactado', async () => {
  const body = Buffer.from(html)
  const response = await post(gzipSync(body), metaFor(body), 'gzip')
  assert.equal(response.status, 200)
  const payload = (await response.json()) as { data: { cards: unknown[] } }
  assert.equal(payload.data.cards.length, 1)
})

test('hash divergente é recusado com 409 (não extrai)', async () => {
  const body = Buffer.from(html)
  const meta = metaFor(body, { htmlHashTrimmed: 'a'.repeat(64) })
  const response = await post(body, meta)
  assert.equal(response.status, 409)
})

test('htmlBytes divergente é recusado com 409', async () => {
  const body = Buffer.from(html)
  const meta = metaFor(body, { htmlBytes: body.length + 10 })
  const response = await post(body, meta)
  assert.equal(response.status, 409)
})

test('contrato incompatível é recusado com 409', async () => {
  const body = Buffer.from(html)
  const response = await post(body, metaFor(body, { contractVersion: '2' }))
  assert.equal(response.status, 409)
})

test('HTML válido sem cards → 200 com quality=no_cards (nunca 503)', async () => {
  const body = Buffer.from('<!doctype html><html><body><p>Nada aqui</p></body></html>')
  const response = await post(body, metaFor(body))
  assert.equal(response.status, 200)
  const payload = (await response.json()) as {
    data: { cards: unknown[]; reason: string; diagnostics: { quality: string } }
  }
  assert.equal(payload.data.cards.length, 0)
  assert.equal(payload.data.reason, 'NO_CARDS_EXTRACTED')
  assert.equal(payload.data.diagnostics.quality, 'no_cards')
})

test('corpo vazio é recusado com 400', async () => {
  const response = await post(Buffer.alloc(0), metaFor(Buffer.alloc(0)))
  assert.equal(response.status, 400)
})
