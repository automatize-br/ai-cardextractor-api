import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../../src/exceptions/ApiError.ts'
import {
  assertPackHash,
  packContentHash,
  parseModelOutput,
  parseTitleDecisions,
  validatePack,
} from '../../src/modules/adjudication/adjudicationValidators.ts'
import { adjudicateDeterministically } from '../../src/modules/adjudication/adjudicationHeuristics.ts'
import type { AdjudicationCard } from '../../src/types/adjudication.ts'
import { makeCard, makePack } from '../packFixture.ts'

function outputFor(
  cardNumber = 1,
  fields: Partial<Record<'c' | 'p' | 't' | 'pr' | 'o' | 'i' | 'cf', unknown>> = {},
): string {
  const item = { c: cardNumber, p: 1, t: 'A', pr: 'A', o: 'B', i: 'A', cf: 90, ...fields }
  return JSON.stringify({ d: [item] })
}

test('validatePack aceita pack valido e rejeita IDs duplicados', () => {
  const pack = validatePack(makePack([makeCard('c1')]))
  assert.equal(pack.cards.length, 1)

  const duplicated = makePack([makeCard('c1'), makeCard('c2')])
  const second = duplicated.cards[1]
  assert.ok(second)
  duplicated.cards[1] = { ...second, titleCandidates: [{ id: 't_c1', text: 'Outro titulo igual' }] }

  assert.throws(
    () => validatePack(duplicated),
    (error: unknown) => error instanceof ApiError && error.code === 'PACK_INVALID',
  )
})

test('assertPackHash valida o hash informado', () => {
  const pack = makePack([makeCard('c1')])
  const hash = packContentHash(pack)
  assert.equal(assertPackHash(pack), hash)

  const withHash = { ...pack, packHash: hash }
  assert.equal(assertPackHash(withHash), hash)

  assert.throws(
    () => assertPackHash({ ...pack, packHash: 'a'.repeat(64) }),
    (error: unknown) => error instanceof ApiError && error.code === 'PACK_INVALID',
  )
})

test('parseModelOutput aceita decisao com letras validas e original maior', () => {
  const pack = validatePack(makePack([makeCard('c1')]))
  const parsed = parseModelOutput(outputFor(1), pack)

  assert.equal(parsed.decisions.length, 1)
  const decision = parsed.decisions[0]
  assert.ok(decision)
  assert.equal(decision.titleId, 't_c1')
  assert.equal(decision.priceId, 'p_c1')
  assert.equal(decision.originalPriceId, 'o_c1')
  assert.equal(decision.confidence, 0.9)
})

test('parseModelOutput descarta letra inexistente', () => {
  const pack = validatePack(makePack([makeCard('c1')]))
  const parsed = parseModelOutput(outputFor(1, { t: 'D' }), pack)

  assert.equal(parsed.decisions.length, 0)
  assert.equal(parsed.rejected[0]?.reason, 'invalid_model_output')
  assert.equal(parsed.validationFailures, 1)
})

test('parseModelOutput descarta card ausente na resposta', () => {
  const pack = validatePack(makePack([makeCard('c1')]))
  const parsed = parseModelOutput(JSON.stringify({ d: [] }), pack)
  assert.equal(parsed.decisions.length, 0)
  assert.equal(parsed.rejected[0]?.reason, 'invalid_model_output')
})

test('parseModelOutput rejeita preco ambiguo e moeda diferente de BRL', () => {
  const ambiguous = makeCard('c1', {
    prices: [
      { id: 'p1', text: 'R$ 199,90', currency: 'BRL', cents: 19990, kind: 'current' },
      { id: 'p2', text: 'R$ 179,90', currency: 'BRL', cents: 17990, kind: 'current' },
    ],
  })
  const parsedAmbiguous = parseModelOutput(
    outputFor(1, { pr: 'A', o: '-' }),
    validatePack(makePack([ambiguous])),
  )
  assert.equal(parsedAmbiguous.rejected[0]?.reason, 'ambiguous_price')

  const usd = makeCard('c2', {
    prices: [{ id: 'p_c2', text: 'US$ 39,90', currency: 'USD', cents: 3990, kind: 'current' }],
  })
  const parsedUsd = parseModelOutput(outputFor(1, { o: '-' }), validatePack(makePack([usd])))
  assert.equal(parsedUsd.rejected[0]?.reason, 'currency_mismatch')
})

test('parseModelOutput marca nao-produto e campos ausentes', () => {
  const pack = validatePack(makePack([makeCard('c1')]))
  const parsed = parseModelOutput(outputFor(1, { p: 0 }), pack)
  assert.equal(parsed.decisions.length, 0)
  assert.equal(parsed.rejected[0]?.reason, 'not_a_product')

  const noPrice = makeCard('c2', { prices: [] })
  const parsedMissing = parseModelOutput(outputFor(1, { p: 1, pr: '-' }), validatePack(makePack([noPrice])))
  assert.equal(parsedMissing.rejected[0]?.reason, 'missing_price')
})


test('heuristicas resolvem cards objetivos sem chamar o modelo', () => {
  const outcome = adjudicateDeterministically([makeCard('c1')])
  assert.equal(outcome.pending.length, 0)
  assert.equal(outcome.decisions.length, 1)
  assert.equal(outcome.decisions[0]?.originalPriceId, 'o_c1')
})

test('heuristicas separam titulos ambiguos para o modelo', () => {
  const card = makeCard('c1', {
    titles: [
      { id: 't1', text: 'Fone Bluetooth JBL Tune 510BT' },
      { id: 't2', text: 'Fone de ouvido sem fio JBL' },
    ],
  })
  const outcome = adjudicateDeterministically([card])
  assert.equal(outcome.decisions.length, 0)
  assert.equal(outcome.pending.length, 1)
  assert.equal(outcome.pending[0]?.titleIds.length, 2)
})

test('heuristicas descartam banner e preco ambiguo', () => {
  const banner = makeCard('c1', { title: 'Patrocinado' })
  const outcomeBanner = adjudicateDeterministically([banner])
  assert.equal(outcomeBanner.rejected[0]?.reason, 'not_a_product')

  const ambiguous = makeCard('c2', {
    prices: [
      { id: 'p1', text: 'R$ 199,90', currency: 'BRL', cents: 19990, kind: 'current' },
      { id: 'p2', text: 'R$ 179,90', currency: 'BRL', cents: 17990, kind: 'current' },
    ],
  })
  const outcomeAmbiguous = adjudicateDeterministically([ambiguous])
  assert.equal(outcomeAmbiguous.rejected[0]?.reason, 'ambiguous_price')
})


test('parseTitleDecisions preserva titulo mesmo com pr/i invalidos', () => {
  const card = makeCard('c1', {
    titles: [
      { id: 't1', text: 'Fone Bluetooth JBL Tune 510BT' },
      { id: 't2', text: 'Fone de ouvido sem fio JBL Tune 510BT original' },
    ],
  })
  const pack = validatePack(makePack([card]))
  const parsed = parseTitleDecisions(
    JSON.stringify({ d: [{ c: 1, p: 1, t: 'B', pr: '-', o: '-', i: '-', cf: 80 }] }),
    pack,
  )
  assert.equal(parsed.get('c1')?.titleId, 't2')
  assert.equal(parsed.get('c1')?.confidence, 0.8)
})


test('parseTitleDecisions marca abstenção (p=1, t="-") como null', () => {
  const card = makeCard('c1', {
    titles: [{ id: 't1', text: 'Fone Bluetooth JBL Tune 510BT' }],
  })
  const pack = validatePack(makePack([card]))
  const parsed = parseTitleDecisions(
    JSON.stringify({ d: [{ c: 1, p: 1, t: '-', pr: 'A', o: '-', i: 'A', cf: 10 }] }),
    pack,
  )
  assert.equal(parsed.get('c1')?.isProduct, null)
})

test('titulo legitimo com "cupom" NAO e ruido', () => {
  const withCoupon = makeCard('c1', { title: 'Tenis Nike com cupom de 20%' })
  const portaCupom = makeCard('c2', { title: 'Porta-cupom de mesa em madeira' })
  const recomenda = makeCard('c3', { title: 'Recomendado para presentes' })
  const outcome = adjudicateDeterministically([withCoupon, portaCupom, recomenda])
  assert.equal(outcome.decisions.length, 3)
  assert.equal(outcome.rejected.length, 0)
})

test('titulo vazio -> missing_title; preco zero -> missing_price', () => {
  const noTitle = makeCard('c1', { titles: [] })
  const zeroPrice = makeCard('c2', {
    prices: [{ id: 'p', text: 'R$ 0', currency: 'BRL', cents: 0, kind: 'current' }],
  })
  const outcome = adjudicateDeterministically([noTitle, zeroPrice])
  assert.equal(outcome.rejected.find((item) => item.cardId === 'c1')?.reason, 'missing_title')
  assert.equal(outcome.rejected.find((item) => item.cardId === 'c2')?.reason, 'missing_price')
})

test('parseTitleDecisions preserva cf do modelo ao dizer nao-produto', () => {
  const pack = validatePack(makePack([makeCard('c1')]))
  const parsed = parseTitleDecisions(
    JSON.stringify({ d: [{ c: 1, p: 0, t: '-', pr: '-', o: '-', i: '-', cf: 37 }] }),
    pack,
  )
  assert.equal(parsed.get('c1')?.isProduct, false)
  assert.equal(parsed.get('c1')?.confidence, 0.37)
})

test('parseTitleDecisions trata p fora de 0/1 como abstenção', () => {
  const pack = validatePack(makePack([makeCard('c1')]))
  const parsed = parseTitleDecisions(
    JSON.stringify({ d: [{ c: 1, p: 2, t: 'A', pr: 'A', o: '-', i: 'A', cf: 90 }] }),
    pack,
  )
  assert.equal(parsed.get('c1')?.isProduct, null)
})

test('context ausente no pack e aceito (opcional no contrato)', () => {
  const card = makeCard('c1') as Partial<AdjudicationCard>
  delete card.context
  const parsed = validatePack({ packVersion: '1', marketplace: 'amazon', packHash: null, cards: [card] })
  assert.deepEqual(parsed.cards[0]?.context, { position: null, breadcrumb: null })
})
