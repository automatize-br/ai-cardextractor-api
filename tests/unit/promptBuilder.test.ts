import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPrompt } from '../../src/modules/execution/promptBuilder.ts'
import { makeProfile } from '../profileFixture.ts'

test('prefixo é estável entre inputs diferentes', () => {
  const profile = makeProfile()
  const first = buildPrompt(profile, { items: [{ id: 'a' }] })
  const second = buildPrompt(profile, { items: [{ id: 'b' }] })
  assert.equal(first.prefixHash, second.prefixHash)
  assert.equal(first.system, second.system)
  assert.notEqual(first.user, second.user)
})

test('prefixo muda quando regra/schema/prompt muda', () => {
  const base = makeProfile()
  const changed = makeProfile({ prompt: { ...base.prompt, system: 'Outro system prompt.' } })
  assert.notEqual(buildPrompt(base, {}).prefixHash, buildPrompt(changed, {}).prefixHash)
})

test('template renderiza input delimitado e não vaza placeholder', () => {
  const prompt = buildPrompt(makeProfile(), { items: [] })
  assert.match(prompt.user, /<INPUT>/)
  assert.match(prompt.user, /<\/INPUT>/)
  assert.equal(prompt.user.includes('{{input}}'), false)
})
