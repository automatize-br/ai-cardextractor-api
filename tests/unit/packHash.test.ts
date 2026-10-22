import assert from 'node:assert/strict'
import test from 'node:test'
import { computePackHash, stableStringify } from '../../src/helpers/packHash.ts'

test('stableStringify nao depende da ordem das chaves', () => {
  const a = { z: 1, a: { y: 2, b: [3, 4] } }
  const b = { a: { b: [3, 4], y: 2 }, z: 1 }
  assert.equal(stableStringify(a), stableStringify(b))
})

test('computePackHash e estavel e sensivel a mudanca de conteudo', () => {
  const first = computePackHash({ packVersion: '1', cards: [{ id: 'c1', cents: 100 }] })
  const second = computePackHash({ cards: [{ cents: 100, id: 'c1' }], packVersion: '1' })
  const changed = computePackHash({ packVersion: '1', cards: [{ id: 'c1', cents: 101 }] })
  assert.equal(first, second)
  assert.notEqual(first, changed)
  assert.match(first, /^[a-f0-9]{64}$/)
})
