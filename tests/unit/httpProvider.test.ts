import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ApiError } from '../../src/exceptions/ApiError.ts'
import { HttpProvider } from '../../src/providers/llm/httpProvider.ts'
import type { CompletionInput, ModelConfig } from '../../src/types/llm.ts'

const config: ModelConfig = {
  id: 'qwen-remote',
  provider: 'http',
  path: '',
  contextSize: 2048,
  version: 'qwen@remote',
}

const input = (overrides: Partial<CompletionInput> = {}): CompletionInput => ({
  system: 'sistema',
  user: 'usuario',
  grammar: null,
  maxTokens: 100,
  temperature: 0,
  timeoutMs: 1000,
  signal: null,
  ...overrides,
})

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('envia chat completions e devolve conteúdo/tokens', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"d":[]}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch

  const provider = new HttpProvider(config, 'http://gpu.local/v1/', 'segredo', 'qwen')
  const result = await provider.complete(input({ grammar: 'root ::= "{}"' }))

  assert.equal(result.text, '{"d":[]}')
  assert.equal(result.tokensIn, 12)
  assert.equal(result.tokensOut, 4)
  assert.equal(calls[0]?.url, 'http://gpu.local/v1/chat/completions')
  const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
  assert.equal(body['model'], 'qwen')
  assert.equal(body['grammar'], 'root ::= "{}"')
  assert.deepEqual((calls[0]?.init.headers as Record<string, string>)['authorization'], 'Bearer segredo')
})

test('HTTP != 2xx vira MODEL_UNAVAILABLE', async () => {
  globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch
  const provider = new HttpProvider(config, 'http://gpu.local/v1', '', 'qwen')
  await assert.rejects(
    () => provider.complete(input()),
    (error: unknown) => error instanceof ApiError && error.code === 'MODEL_UNAVAILABLE',
  )
})

test('resposta sem content vira MODEL_UNAVAILABLE', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch
  const provider = new HttpProvider(config, 'http://gpu.local/v1', '', 'qwen')
  await assert.rejects(
    () => provider.complete(input()),
    (error: unknown) => error instanceof ApiError && error.code === 'MODEL_UNAVAILABLE',
  )
})

test('timeout aborta a requisição como MODEL_TIMEOUT', async () => {
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })) as typeof fetch
  const provider = new HttpProvider(config, 'http://gpu.local/v1', '', 'qwen')
  await assert.rejects(
    () => provider.complete(input({ timeoutMs: 5 })),
    (error: unknown) => error instanceof ApiError && error.code === 'MODEL_TIMEOUT',
  )
})

test('base URL vazia → isReady=false e erro explícito', async () => {
  const provider = new HttpProvider(config, '', '', 'qwen')
  assert.equal(await provider.isReady(), false)
  await assert.rejects(
    () => provider.complete(input()),
    (error: unknown) => error instanceof ApiError && error.code === 'MODEL_UNAVAILABLE',
  )
})
