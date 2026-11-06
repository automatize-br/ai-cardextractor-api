import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { AnthropicProvider } from '../../src/providers/llm/anthropicProvider.ts'
import type { RegisteredModel } from '../../src/types/model.ts'

const model: RegisteredModel = {
  id: 'claude',
  version: 'claude@1',
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  baseUrl: 'https://api.anthropic.com/v1',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  structuredOutput: 'json_schema',
  promptCaching: 'explicit',
  maxContext: 200000,
  maxOutput: 2048,
  cost: null,
  modelHash: 'b'.repeat(64),
}

const originalFetch = globalThis.fetch
const originalKey = process.env['ANTHROPIC_API_KEY']

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env['ANTHROPIC_API_KEY']
  else process.env['ANTHROPIC_API_KEY'] = originalKey
})

test('envia output_config e cache_control para Anthropic', async () => {
  process.env['ANTHROPIC_API_KEY'] = 'segredo'
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(
      JSON.stringify({
        content: [{ type: 'text', text: '{"items":[]}' }],
        usage: {
          input_tokens: 120,
          output_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 5,
        },
        stop_reason: 'end_turn',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch

  const provider = new AnthropicProvider(model)
  const result = await provider.complete({
    system: 'sistema estável',
    user: 'input',
    outputSchema: { type: 'object', additionalProperties: false, properties: {} },
    maxTokens: 100,
    temperature: 0,
    topP: 1,
    timeoutMs: 1000,
    signal: null,
  })

  assert.equal(result.text, '{"items":[]}')
  assert.equal(result.tokensIn, 120)
  assert.equal(result.tokensOut, 10)
  assert.equal(result.cachedTokens, 100)
  assert.equal(result.cacheWriteTokens, 5)
  assert.equal(result.finishReason, 'end_turn')
  assert.equal(calls[0]?.url, 'https://api.anthropic.com/v1/messages')

  const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
  assert.equal(body['model'], 'claude-haiku-5-5')
  assert.equal(body['max_tokens'], 100)
  assert.equal(Array.isArray(body['system']), true)
  assert.deepEqual((body['system'] as Array<Record<string, unknown>>)[0]?.['cache_control'], {
    type: 'ephemeral',
  })
  assert.deepEqual(body['output_config'], {
    format: {
      type: 'json_schema',
      schema: { type: 'object', additionalProperties: false, properties: {} },
    },
  })
  assert.equal((calls[0]?.init.headers as Record<string, string>)['x-api-key'], 'segredo')
  assert.equal((calls[0]?.init.headers as Record<string, string>)['anthropic-version'], '2023-06-01')
})

test('HTTP != 2xx vira MODEL_UNAVAILABLE no Anthropic', async () => {
  globalThis.fetch = (async () => new Response('nope', { status: 429 })) as typeof fetch
  const provider = new AnthropicProvider(model)
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
    /Anthropic responded 429/,
  )
})
