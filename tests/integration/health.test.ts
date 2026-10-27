import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { createApp } from '../../src/app.ts'
import { resetProfilesForTests } from '../../src/config/profiles.ts'
import { makeProfile } from '../profileFixture.ts'

const app = createApp()
let server: ReturnType<typeof app.listen>
let baseUrl = ''

before(async () => {
  server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('GET /api/v1/helt e publico e retorna texto simples', async () => {
  const response = await fetch(`${baseUrl}/api/v1/helt`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/plain/)
  assert.equal(await response.text(), 'api-scrapping funcionando ok')
})

test('GET /api/v1/health e publico', async () => {
  const response = await fetch(`${baseUrl}/api/v1/health`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as { success: boolean; data: { status: string } }
  assert.equal(body.success, true)
  assert.equal(body.data.status, 'ok')
})

test('GET /api/v1/ready exige chave interna', async () => {
  const unauthorized = await fetch(`${baseUrl}/api/v1/ready`)
  assert.equal(unauthorized.status, 401)

  const authorized = await fetch(`${baseUrl}/api/v1/ready`, {
    headers: { 'x-internal-key': 'test-internal-key' },
  })
  assert.equal(authorized.status, 200)
  const body = (await authorized.json()) as { success: boolean; data: { ready: boolean } }
  assert.equal(body.data.ready, true)
})

test('GET /v1/health funciona como alias', async () => {
  const response = await fetch(`${baseUrl}/v1/health`)
  assert.equal(response.status, 200)
})

test('GET /api/v1/profiles exige chave e lista apenas metadados', async () => {
  const unauthorized = await fetch(`${baseUrl}/api/v1/profiles`)
  assert.equal(unauthorized.status, 401)

  process.env['AI_PROFILES_JSON'] = JSON.stringify([makeProfile({ id: 'cards' })])
  resetProfilesForTests()
  try {
    const response = await fetch(`${baseUrl}/api/v1/profiles`, {
      headers: { 'x-internal-key': 'test-internal-key' },
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      success: boolean
      data: { profiles: Array<Record<string, unknown>> }
    }
    assert.equal(body.success, true)
    assert.equal(body.data.profiles.length, 1)
    assert.equal(body.data.profiles[0]?.['id'], 'cards')
    assert.equal(body.data.profiles[0]?.['promptHash'] !== undefined, true)
    assert.equal('prompt' in (body.data.profiles[0] ?? {}), false)
    assert.equal('schema' in (body.data.profiles[0] ?? {}), false)
  } finally {
    delete process.env['AI_PROFILES_JSON']
    resetProfilesForTests()
  }
})
