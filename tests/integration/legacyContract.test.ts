import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { createApp } from '../../src/app.ts'
import type { AdjudicationResult } from '../../src/types/adjudication.ts'
import { makeCard, makePack } from '../packFixture.ts'

// ============================================================================
// Contrato dourado do fluxo legado. Qualquer refatoração para o pipeline v2
// precisa manter esta resposta completa (não só `decisions`).
// ============================================================================

const app = createApp()
let server: ReturnType<typeof app.listen>
let baseUrl = ''

const AUTH = { 'x-internal-key': 'test-internal-key' }

before(async () => {
  server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('contrato legado completo permanece estável', async () => {
  const pack = makePack([
    makeCard('c1', {
      titles: [
        { id: 't1', text: 'Fone Bluetooth JBL Tune 510BT' },
        { id: 't2', text: 'Fone de ouvido sem fio JBL original' },
      ],
    }),
    makeCard('c2', { title: 'Patrocinado' }),
  ])

  const response = await fetch(`${baseUrl}/api/v1/adjudicate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify(pack),
  })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { success: boolean; data: AdjudicationResult }
  assert.equal(body.success, true)

  const result = body.data
  assert.deepEqual(Object.keys(result).sort(), [
    'decisions',
    'fallbackReason',
    'latencyMs',
    'mode',
    'modelId',
    'modelVersion',
    'packHash',
    'packVersion',
    'promptVersion',
    'rejected',
  ])
  assert.equal(result.packVersion, '1')
  assert.match(result.packHash, /^[a-f0-9]{64}$/)
  assert.equal(result.mode, 'fake')
  assert.equal(result.modelId, 'fake-adjudicator')
  assert.equal(result.modelVersion, 'fake@test')
  assert.equal(result.promptVersion, '1')
  assert.equal(result.fallbackReason, null)
  assert.equal(result.decisions.length, 1)
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0]?.cardId, 'c2')
  assert.equal(result.rejected[0]?.reason, 'not_a_product')

  const decision = result.decisions[0]
  assert.deepEqual(Object.keys(decision ?? {}).sort(), [
    'cardId',
    'confidence',
    'imageId',
    'isProduct',
    'needsReview',
    'originalPriceId',
    'priceId',
    'reviewReasons',
    'source',
    'titleId',
  ])
  assert.equal(decision?.cardId, 'c1')
  assert.equal(decision?.source, 'model')
  assert.equal(decision?.isProduct, true)
  assert.equal(decision?.titleId, 't2')
  assert.equal(decision?.priceId, 'p_c1')
  assert.equal(decision?.originalPriceId, 'o_c1')
  assert.equal(decision?.imageId, 'i_c1')
  assert.equal(decision?.confidence, 0.9)
  assert.equal(decision?.needsReview, false)
  assert.deepEqual(decision?.reviewReasons, [])
})
