import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LETTERS,
  MAX_CANDIDATES,
  NONE_LETTER,
  indexForLetter,
  isCandidateLetter,
  letterFor,
} from '../../src/providers/llm/candidateRef.ts'

test('alfabeto de candidatos é fixo A-L e "-"', () => {
  assert.equal(LETTERS.length, 12)
  assert.equal(MAX_CANDIDATES, 12)
  assert.equal(NONE_LETTER, '-')
  assert.equal(letterFor(0), 'A')
  assert.equal(letterFor(11), 'L')
  assert.equal(letterFor(12), '-')
  assert.equal(indexForLetter('A'), 0)
  assert.equal(indexForLetter('L'), 11)
  assert.equal(indexForLetter('-'), -1)
})

test('isCandidateLetter rejeita letras fora da faixa', () => {
  assert.equal(isCandidateLetter('A'), true)
  assert.equal(isCandidateLetter('-'), true)
  assert.equal(isCandidateLetter('M'), false)
  assert.equal(isCandidateLetter(1), false)
})
