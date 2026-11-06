import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FakeProvider } from '../../src/providers/llm/fakeProvider.ts'

const baseInput = {
  system: 's',
  user: 'u',
  grammar: null,
  maxTokens: 100,
  temperature: 0,
  timeoutMs: 1000,
  signal: null,
}

test('fake usa metadata.fakeOutput sem parsear o prompt', async () => {
  const provider = new FakeProvider('fake-test', 'fake-test@1')
  const result = await provider.complete({
    ...baseInput,
    user: 'formato completamente diferente',
    metadata: { fakeOutput: { items: [{ item: 1, choice: 'B', confidence: 90 }] } },
  })
  assert.deepEqual(JSON.parse(result.text), { items: [{ item: 1, choice: 'B', confidence: 90 }] })
})

test('fake mantém o parser legado quando não há metadata', async () => {
  const provider = new FakeProvider('fake-test', 'fake-test@1')
  const result = await provider.complete({
    ...baseInput,
    user: [
      'marketplace=amazon',
      'cards:',
      'card 1 (id=c1) host=amazon.com.br pos=1 cat=-',
      ' T A="Fone Bluetooth JBL Tune 510BT"',
      ' P A moeda=BRL centavos=19990 tipo=current texto="R$ 199,90"',
      ' I A',
    ].join('\n'),
  })
  const payload = JSON.parse(result.text) as { d: Array<{ c: number; p: number }> }
  assert.equal(payload.d[0]?.c, 1)
  assert.equal(payload.d[0]?.p, 1)
})
