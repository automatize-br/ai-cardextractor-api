import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ApiError } from '../../src/exceptions/ApiError.ts'
import { HttpVisionProvider } from '../../src/providers/vision/httpVisionProvider.ts'

const images = ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg']
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('envia texto+imagens e devolve scores na mesma ordem', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify({ scores: [0.2, 0.9] }), { status: 200 })
  }) as typeof fetch

  const provider = new HttpVisionProvider('http://clip.local', 'chave')
  const scores = await provider.score({ text: 'Fone JBL', images, timeoutMs: 500 })

  assert.deepEqual(scores, [0.2, 0.9])
  assert.equal(calls[0]?.url, 'http://clip.local/score')
  const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
  assert.equal(body['text'], 'Fone JBL')
  assert.deepEqual(body['images'], images)
  assert.equal((calls[0]?.init.headers as Record<string, string>)['authorization'], 'Bearer chave')
})

test('scores com tamanho errado ou fora de 0..1 são rejeitados', async () => {
  for (const payload of [{ scores: [0.9] }, { scores: [0.9, 2] }, { scores: ['0.9', 0.2] }, {}]) {
    globalThis.fetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch
    const provider = new HttpVisionProvider('http://clip.local', '')
    await assert.rejects(
      () => provider.score({ text: 'x', images, timeoutMs: 500 }),
      (error: unknown) => error instanceof ApiError && error.code === 'MODEL_UNAVAILABLE',
    )
  }
})

test('HTTP != 2xx vira MODEL_UNAVAILABLE', async () => {
  globalThis.fetch = (async () => new Response('erro', { status: 502 })) as typeof fetch
  const provider = new HttpVisionProvider('http://clip.local', '')
  await assert.rejects(
    () => provider.score({ text: 'x', images, timeoutMs: 500 }),
    (error: unknown) => error instanceof ApiError && error.code === 'MODEL_UNAVAILABLE',
  )
})

test('sem URL configurada → não está pronto e falha explícita', async () => {
  const provider = new HttpVisionProvider('', '')
  assert.equal(await provider.isReady(), false)
  await assert.rejects(
    () => provider.score({ text: 'x', images, timeoutMs: 500 }),
    (error: unknown) => error instanceof ApiError && error.code === 'MODEL_UNAVAILABLE',
  )
})
