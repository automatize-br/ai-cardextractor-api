import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { createApp } from '../../src/app.ts'
import { disposeProviders } from '../../src/providers/llm/index.ts'
import type { AdjudicationResult } from '../../src/types/adjudication.ts'
import { makeCard, makePack } from '../packFixture.ts'

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

function postAdjudicate(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/adjudicate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify(body),
  })
}

test('adjudicate exige chave interna', async () => {
  const response = await fetch(`${baseUrl}/api/v1/adjudicate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(makePack([makeCard('c1')])),
  })
  assert.equal(response.status, 401)
})

test('adjudicate valida pack invalido com 400 estruturado', async () => {
  const response = await postAdjudicate({ packVersion: '1', marketplace: 'amazon', packHash: null, cards: [] })
  assert.equal(response.status, 400)
  const body = (await response.json()) as { success: boolean; code: string }
  assert.equal(body.success, false)
  assert.equal(body.code, 'PACK_INVALID')
})

test('adjudicate retorna decisao validada e hash', async () => {
  const response = await postAdjudicate(makePack([makeCard('c1'), makeCard('c2', { title: 'Patrocinado' })]))
  assert.equal(response.status, 200)

  const body = (await response.json()) as { success: boolean; data: AdjudicationResult }
  const result = body.data
  assert.equal(result.mode, 'heuristic')
  assert.match(result.packHash, /^[a-f0-9]{64}$/)
  assert.equal(result.modelId, 'fake-adjudicator')
  assert.equal(result.modelVersion, 'fake@test')
  assert.equal(result.decisions.length, 1)
  assert.equal(result.decisions[0]?.cardId, 'c1')
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0]?.reason, 'not_a_product')
  assert.equal(result.fallbackReason, null)
})

test('adjudicate usa o modelo apenas para titulos ambiguos', async () => {
  const card = makeCard('c1', {
    titles: [
      { id: 't1', text: 'Fone Bluetooth JBL Tune 510BT' },
      { id: 't2', text: 'Fone de ouvido sem fio JBL original' },
    ],
  })
  const response = await postAdjudicate(makePack([card]))
  assert.equal(response.status, 200)
  const body = (await response.json()) as { data: AdjudicationResult }
  assert.equal(body.data.mode, 'fake')
  assert.equal(body.data.decisions.length, 1)
  assert.equal(body.data.decisions[0]?.titleId, 't2')
  assert.equal(body.data.decisions[0]?.priceId, 'p_c1')
})

test('stats reflete a adjudicacao anterior', async () => {
  const response = await fetch(`${baseUrl}/api/v1/stats`, { headers: AUTH })
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    data: { total: number; llm: number; heuristic: number; fallback: number }
  }
  assert.ok(body.data.total >= 1)
  assert.equal(body.data.fallback, 0)
  assert.ok(body.data.llm >= 1)
  assert.ok(body.data.heuristic >= 1)
  assert.equal(body.data.total, body.data.llm + body.data.heuristic + body.data.fallback)
})


function ambiguousCard(cardId: string, suffix = ''): ReturnType<typeof makeCard> {
  return makeCard(cardId, {
    titles: [
      { id: `t1_${cardId}${suffix}`, text: 'Fone Bluetooth JBL Tune 510BT' },
      { id: `t2_${cardId}${suffix}`, text: 'Fone de ouvido sem fio JBL Tune 510BT original' },
    ],
  })
}

test('falha do modelo no meio do lote preserva decisoes ja tomadas', async () => {
  await disposeProviders()
  process.env['FAKE_FAIL_AFTER'] = '1'
  try {
    const pack = makePack([
      ambiguousCard('c1'),
      ambiguousCard('c2'),
      ambiguousCard('c3'),
    ])
    const response = await postAdjudicate(pack)
    assert.equal(response.status, 200)
    const body = (await response.json()) as { data: AdjudicationResult }
    assert.equal(body.data.mode, 'fallback')
    assert.equal(body.data.fallbackReason, 'provider_error')
    assert.equal(body.data.decisions.length, 3)
    assert.equal(body.data.rejected.length, 0)
    const last = body.data.decisions.find((item) => item.cardId === 'c3')
    assert.equal(last?.needsReview, true)
    assert.ok(last?.reviewReasons.includes('model_fallback'))
  } finally {
    delete process.env['FAKE_FAIL_AFTER']
  }
})

test('AI_ADJ_MODE=off nao chama o modelo e marca revisao', async () => {
  process.env['AI_ADJ_MODE'] = 'off'
  try {
    const response = await postAdjudicate(makePack([ambiguousCard('c1')]))
    assert.equal(response.status, 200)
    const body = (await response.json()) as { data: AdjudicationResult }
    assert.equal(body.data.mode, 'heuristic')
    assert.equal(body.data.decisions[0]?.needsReview, true)
    assert.ok(body.data.decisions[0]?.reviewReasons.includes('ambiguous_title'))
  } finally {
    process.env['AI_ADJ_MODE'] = 'on'
  }
})

test('toda card aparece exatamente uma vez em decisions ou rejected', async () => {
  const pack = makePack([
    ambiguousCard('c1'),
    makeCard('c2', { title: 'Patrocinado' }),
    makeCard('c3'),
  ])
  const response = await postAdjudicate(pack)
  const body = (await response.json()) as { data: AdjudicationResult }
  const ids = [
    ...body.data.decisions.map((item) => item.cardId),
    ...body.data.rejected.map((item) => item.cardId),
  ].sort()
  assert.deepEqual(ids, ['c1', 'c2', 'c3'])
})

test('pack acima do limite retorna 400 PACK_TOO_LARGE', async () => {
  const cards = Array.from({ length: 31 }, (_value, index) => makeCard(`c${index + 1}`))
  const response = await postAdjudicate(makePack(cards))
  assert.equal(response.status, 400)
  const body = (await response.json()) as { code: string }
  assert.equal(body.code, 'PACK_TOO_LARGE')
})


test('timeout do provider preserva cards como revisao, nunca perda', async () => {
  process.env['FAKE_DELAY_MS'] = '5000'
  try {
    const response = await postAdjudicate(makePack([ambiguousCard('c1')]))
    assert.equal(response.status, 200)
    const body = (await response.json()) as { data: AdjudicationResult }
    assert.equal(body.data.mode, 'fallback')
    assert.equal(body.data.fallbackReason, 'MODEL_TIMEOUT')
    assert.equal(body.data.decisions.length, 1)
    assert.equal(body.data.decisions[0]?.needsReview, true)
    assert.ok(body.data.decisions[0]?.reviewReasons.includes('model_fallback'))
  } finally {
    delete process.env['FAKE_DELAY_MS']
  }
})

test('shadow devolve decisao deterministica e nao aplica o modelo', async () => {
  process.env['AI_ADJ_MODE'] = 'shadow'
  try {
    const response = await postAdjudicate(makePack([ambiguousCard('c1')]))
    const body = (await response.json()) as { data: AdjudicationResult }
    assert.equal(body.data.mode, 'heuristic')
    assert.equal(body.data.decisions[0]?.confidence, 0.4)
    assert.equal(body.data.decisions[0]?.needsReview, true)
    assert.ok(body.data.decisions[0]?.reviewReasons.includes('ambiguous_title'))
  } finally {
    process.env['AI_ADJ_MODE'] = 'on'
  }
})

test('assist nao aplica titulo do modelo abaixo do limiar', async () => {
  process.env['AI_ADJ_MODE'] = 'assist'
  process.env['FAKE_CONFIDENCE'] = '10'
  try {
    const response = await postAdjudicate(makePack([ambiguousCard('c1')]))
    const body = (await response.json()) as { data: AdjudicationResult }
    const decision = body.data.decisions[0]
    assert.equal(decision?.source, 'heuristic')
    assert.equal(decision?.needsReview, true)
    assert.ok(decision?.reviewReasons.includes('ambiguous_title'))
    assert.ok(decision?.reviewReasons.includes('low_confidence'))
    // Fake escolhe o titulo mais longo; a heuristica tambem. O que importa e a
    // proveniencia e a revisao, nao a escolha.
    assert.equal(decision?.titleId, 't2_c1')
  } finally {
    delete process.env['FAKE_CONFIDENCE']
    process.env['AI_ADJ_MODE'] = 'on'
  }
})

test('assist NAO descarta oferta quando o modelo diz nao-produto com baixa confianca', async () => {
  process.env['AI_ADJ_MODE'] = 'assist'
  process.env['FAKE_CONFIDENCE'] = '5'
  try {
    const card = makeCard('c1', {
      titles: [
        { id: 't1', text: 'Cupom de desconto especial' },
        { id: 't2', text: 'Fone Bluetooth JBL Tune 510BT' },
      ],
    })
    const response = await postAdjudicate(makePack([card]))
    const body = (await response.json()) as { data: AdjudicationResult }
    assert.equal(body.data.rejected.length, 0)
    assert.equal(body.data.decisions.length, 1)
    assert.equal(body.data.decisions[0]?.needsReview, true)
  } finally {
    delete process.env['FAKE_CONFIDENCE']
    process.env['AI_ADJ_MODE'] = 'on'
  }
})

test('on descarta nao-produto apenas com confianca acima do limiar', async () => {
  process.env['AI_ADJ_MODE'] = 'on'
  process.env['FAKE_CONFIDENCE'] = '90'
  try {
    const card = makeCard('c1', {
      titles: [
        { id: 't1', text: 'Cupom de desconto especial' },
        { id: 't2', text: 'Fone Bluetooth JBL Tune 510BT' },
      ],
    })
    const response = await postAdjudicate(makePack([card]))
    const body = (await response.json()) as { data: AdjudicationResult }
    assert.equal(body.data.decisions.length, 0)
    assert.equal(body.data.rejected[0]?.reason, 'not_a_product')
  } finally {
    delete process.env['FAKE_CONFIDENCE']
  }
})
