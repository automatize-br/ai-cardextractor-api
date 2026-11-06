import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { GeminiProvider } from '../../src/providers/llm/geminiProvider.ts'
import type { RegisteredModel } from '../../src/types/model.ts'

const model: RegisteredModel = {
  id: 'gemini',
  version: 'gemini@1',
  provider: 'gemini',
  model: 'gemini-3.5-flash-lite',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  apiKeyEnv: 'GEMINI_API_KEY',
  structuredOutput: 'json_schema',
  promptCaching: 'auto',
  maxContext: 1000000,
  maxOutput: 2048,
  cost: null,
  modelHash: 'c'.repeat(64),
}

const originalFetch = globalThis.fetch
const originalKey = process.env['GEMINI_API_KEY']

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env['GEMINI_API_KEY']
  else process.env['GEMINI_API_KEY'] = originalKey
})

test('envia responseSchema sanitizado e devolve usage/cache do Gemini', async () => {
  process.env['GEMINI_API_KEY'] = 'segredo'
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: '{"items":[]}' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 10,
          cachedContentTokenCount: 80,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch

  const provider = new GeminiProvider(model)
  const result = await provider.complete({
    system: 'sistema estável',
    user: 'input',
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { items: { type: 'array', items: { type: 'string' } } },
    },
    maxTokens: 100,
    temperature: 0,
    topP: 1,
    timeoutMs: 1000,
    signal: null,
  })

  assert.equal(result.text, '{"items":[]}')
  assert.equal(result.tokensIn, 120)
  assert.equal(result.tokensOut, 10)
  assert.equal(result.cachedTokens, 80)
  assert.equal(result.finishReason, 'STOP')
  assert.equal(
    calls[0]?.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
  )

  const body = JSON.parse(String(calls[0]?.init.body)) as {
    generationConfig: Record<string, unknown>
    systemInstruction: unknown
  }
  assert.equal(body.generationConfig['responseMimeType'], 'application/json')
  const schema = body.generationConfig['responseSchema'] as Record<string, unknown>
  assert.equal(schema['additionalProperties'], undefined)
  assert.deepEqual(schema['properties'], { items: { type: 'array', items: { type: 'string' } } })
  assert.equal((calls[0]?.init.headers as Record<string, string>)['x-goog-api-key'], 'segredo')
})

test('HTTP != 2xx vira MODEL_UNAVAILABLE no Gemini', async () => {
  globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch
  const provider = new GeminiProvider(model)
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
    /Gemini responded 500/,
  )
})
