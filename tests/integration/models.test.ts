import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { createApp } from '../../src/app.ts'
import { resetModelsForTests } from '../../src/config/models.ts'

const app = createApp()
let server: ReturnType<typeof app.listen>
let baseUrl = ''

const AUTH = { 'x-internal-key': 'test-internal-key' }
const ORIGINAL_MODELS = process.env['AI_MODELS_JSON']

before(async () => {
  server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (ORIGINAL_MODELS === undefined) delete process.env['AI_MODELS_JSON']
  else process.env['AI_MODELS_JSON'] = ORIGINAL_MODELS
  resetModelsForTests()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('GET /models expõe catálogo v2 sem segredos', async () => {
  process.env['AI_MODELS_JSON'] = JSON.stringify([
    {
      id: 'claude',
      version: 'claude@1',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      structuredOutput: 'json_schema',
      promptCaching: 'explicit',
    },
  ])
  resetModelsForTests()

  const response = await fetch(`${baseUrl}/api/v1/models`, { headers: AUTH })
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    data: { catalog: Array<Record<string, unknown>> }
  }
  const entry = body.data.catalog[0]
  assert.equal(entry?.['id'], 'claude')
  assert.equal(entry?.['provider'], 'anthropic')
  assert.equal(entry?.['ready'], true)
  assert.equal('baseUrl' in (entry ?? {}), false)
  assert.equal('apiKeyEnv' in (entry ?? {}), false)
})
