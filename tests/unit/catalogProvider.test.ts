import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { OpenAICompatibleProvider } from '../../src/providers/llm/catalogProvider.ts'
import type { RegisteredModel } from '../../src/types/model.ts'

const model: RegisteredModel = {
  id: 'remote',
  version: 'remote@1',
  provider: 'openai-compatible',
  model: 'gpt-test',
  baseUrl: 'https://example.com/v1',
  apiKeyEnv: 'OPENAI_API_KEY',
  structuredOutput: 'json_schema',
  promptCaching: 'auto',
  maxContext: 128000,
  maxOutput: 2048,
  cost: null,
  modelHash: 'a'.repeat(64),
}

const originalFetch = globalThis.fetch
const originalKey = process.env['OPENAI_API_KEY']

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env['OPENAI_API_KEY']
  else process.env['OPENAI_API_KEY'] = originalKey
})

test('envia response_format e devolve usage/cache', async () => {
  process.env['OPENAI_API_KEY'] = 'segredo'
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"items":[]}' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 5 },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch

  const provider = new OpenAICompatibleProvider(model)
  const result = await provider.complete({
    system: 's',
    user: 'u',
    outputSchema: { type: 'object', additionalProperties: false, properties: {} },
    maxTokens: 100,
    temperature: 0,
    topP: 1,
    timeoutMs: 1000,
    signal: null,
    promptCacheKey: 'cache-key',
  })

  assert.equal(result.text, '{"items":[]}')
  assert.equal(result.tokensIn, 120)
  assert.equal(result.tokensOut, 10)
  assert.equal(result.cachedTokens, 100)
  assert.equal(result.cacheWriteTokens, 5)
  assert.equal(calls[0]?.url, 'https://example.com/v1/chat/completions')

  const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
  assert.equal(body['model'], 'gpt-test')
  assert.equal(body['prompt_cache_key'], 'cache-key')
  assert.deepEqual(body['response_format'], {
    type: 'json_schema',
    json_schema: {
      name: 'output',
      schema: { type: 'object', additionalProperties: false, properties: {} },
      strict: true,
    },
  })
  assert.equal((calls[0]?.init.headers as Record<string, string>)['authorization'], 'Bearer segredo')
})

test('HTTP != 2xx vira MODEL_UNAVAILABLE', async () => {
  globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch
  const provider = new OpenAICompatibleProvider(model)
  await assert.rejects(
    () =>
      provider.complete({
        system: 's',
        user: 'u',
        outputSchema: { type: 'object' },
        maxTokens: 10,
        temperature: 0,
        topP: 1,
        timeoutMs: 1000,
        signal: null,
      }),
    /HTTP provider responded 500/,
  )
})
