import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { createApp } from '../../src/app.ts'
import { resetAppCacheForTests } from '../../src/cache/appCache.ts'
import { resetModelsForTests } from '../../src/config/models.ts'
import { resetProfilesForTests } from '../../src/config/profiles.ts'
import {
  fakeCatalogCallCount,
  resetCatalogProvidersForTests,
  resetFakeCatalogCallsForTests,
} from '../../src/providers/llm/catalogProvider.ts'
import type { ExecutionResult } from '../../src/types/execution.ts'
import { makeProfile } from '../profileFixture.ts'

const app = createApp()
let server: ReturnType<typeof app.listen>
let baseUrl = ''

const AUTH = { 'x-internal-key': 'test-internal-key' }

function configureProfile(): void {
  process.env['AI_PROFILES_JSON'] = JSON.stringify([makeProfile({ id: 'cards' })])
  process.env['AI_MODELS_JSON'] = ''
  resetProfilesForTests()
  resetModelsForTests()
  resetCatalogProvidersForTests()
  resetAppCacheForTests()
  resetFakeCatalogCallsForTests()
}

function postExecute(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify(body),
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

test('/execute exige chave interna', async () => {
  const response = await fetch(`${baseUrl}/api/v1/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile: 'cards', input: { items: [] } }),
  })
  assert.equal(response.status, 401)
})

test('/execute executa perfil configurado com fake e valida saída', async () => {
  configureProfile()
  process.env['FAKE_EXECUTION_OUTPUT'] = JSON.stringify({
    items: [{ item: 1, choice: 'A', confidence: 90 }],
  })
  try {
    const response = await postExecute({
      profile: 'cards',
      input: { items: [{ id: 'x' }] },
      options: { mode: 'on' },
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as { success: boolean; data: ExecutionResult }
    assert.equal(body.success, true)
    const result = body.data
    assert.equal(result.profileId, 'cards')
    assert.equal(result.profileVersion, '1.0.0')
    assert.equal(result.mode, 'fake')
    assert.equal(result.modelId, 'fake-adjudicator')
    assert.equal(result.modelVersion, 'fake@test')
    assert.equal(result.validation.ok, true)
    assert.deepEqual(result.output, { items: [{ item: 1, choice: 'A', confidence: 90 }] })
    assert.equal(result.fallbackReason, null)
  } finally {
    delete process.env['FAKE_EXECUTION_OUTPUT']
  }
})

test('/execute funciona com o perfil de exemplo profiles/cards.json', async () => {
  const profile = JSON.parse(readFileSync('profiles/cards.json', 'utf8')) as unknown
  process.env['AI_PROFILES_JSON'] = JSON.stringify([profile])
  process.env['AI_MODELS_JSON'] = JSON.stringify([
    {
      id: 'fast',
      version: 'fast@1',
      provider: 'fake',
      model: 'fake',
      baseUrl: '',
      apiKeyEnv: '',
      structuredOutput: 'json_schema',
      promptCaching: 'off',
    },
  ])
  process.env['FAKE_EXECUTION_OUTPUT'] = JSON.stringify({
    items: [{ item: 1, isProduct: true, title: 'A', price: 'A', original: 'B', image: 'A', confidence: 90 }],
  })
  resetProfilesForTests()
  resetModelsForTests()
  resetCatalogProvidersForTests()
  resetAppCacheForTests()
  resetFakeCatalogCallsForTests()

  try {
    const response = await postExecute({
      profile: 'cards',
      input: {
        marketplace: 'amazon',
        cards: [
          {
            cardId: 'c1',
            titleCandidates: [{ id: 't1', text: 'Fone Bluetooth JBL Tune 510BT' }],
            priceCandidates: [
              { id: 'p1', text: 'R$ 199,90', currency: 'BRL', cents: 19990, kind: 'current' },
              { id: 'p2', text: 'R$ 249,90', currency: 'BRL', cents: 24990, kind: 'original' },
            ],
            imageCandidates: [{ id: 'i1', url: 'https://m.media-amazon.com/images/I/x.jpg' }],
          },
        ],
      },
      options: { mode: 'on' },
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as { data: ExecutionResult }
    assert.equal(body.data.validation.ok, true)
    assert.equal(body.data.mode, 'fake')
    assert.deepEqual(body.data.output, {
      items: [{ item: 1, isProduct: true, title: 'A', price: 'A', original: 'B', image: 'A', confidence: 90 }],
    })
  } finally {
    delete process.env['FAKE_EXECUTION_OUTPUT']
    delete process.env['AI_PROFILES_JSON']
    delete process.env['AI_MODELS_JSON']
    resetProfilesForTests()
    resetModelsForTests()
    resetCatalogProvidersForTests()
  }
})

test('/execute usa cache de aplicação e não chama o provider na segunda vez', async () => {
  configureProfile()
  process.env['FAKE_EXECUTION_OUTPUT'] = JSON.stringify({
    items: [{ item: 1, choice: 'A', confidence: 90 }],
  })
  const body = {
    profile: 'cards',
    input: { items: [{ id: 'cache' }] },
    options: { mode: 'on' },
  }
  try {
    const first = await postExecute(body)
    const firstBody = (await first.json()) as { data: ExecutionResult }
    assert.equal(firstBody.data.cache.appHit, false)

    const second = await postExecute(body)
    const secondBody = (await second.json()) as { data: ExecutionResult }
    assert.equal(secondBody.data.cache.appHit, true)
    assert.equal(fakeCatalogCallCount(), 1)
  } finally {
    delete process.env['FAKE_EXECUTION_OUTPUT']
  }
})

test('/execute devolve fallback seguro quando a saída viola o schema', async () => {
  configureProfile()
  process.env['FAKE_EXECUTION_OUTPUT'] = JSON.stringify({ items: [] })
  try {
    const response = await postExecute({
      profile: 'cards',
      input: { items: [{ id: 'x' }] },
      options: { mode: 'on' },
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as { data: ExecutionResult }
    assert.equal(body.data.mode, 'fallback')
    assert.equal(body.data.output, null)
    assert.equal(body.data.validation.ok, false)
    assert.equal(body.data.fallbackReason, 'INVALID_MODEL_OUTPUT')
  } finally {
    delete process.env['FAKE_EXECUTION_OUTPUT']
  }
})

test('/execute rejeita input fora do schema', async () => {
  configureProfile()
  const response = await postExecute({
    profile: 'cards',
    input: { items: 'não é array' },
    options: { mode: 'on' },
  })
  assert.equal(response.status, 400)
  const body = (await response.json()) as { code: string }
  assert.equal(body.code, 'INPUT_INVALID')
})

test('/execute rejeita perfil desconhecido', async () => {
  configureProfile()
  const response = await postExecute({
    profile: 'missing',
    input: { items: [{ id: 'x' }] },
    options: { mode: 'on' },
  })
  assert.equal(response.status, 404)
  const body = (await response.json()) as { code: string }
  assert.equal(body.code, 'UNKNOWN_PROFILE')
})

test('/execute em mode=off não chama provider', async () => {
  configureProfile()
  const response = await postExecute({
    profile: 'cards',
    input: { items: [{ id: 'x' }] },
    options: { mode: 'off' },
  })
  assert.equal(response.status, 503)
  const body = (await response.json()) as { code: string }
  assert.equal(body.code, 'MODEL_DISABLED')
})
