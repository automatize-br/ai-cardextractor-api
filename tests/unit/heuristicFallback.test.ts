import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { buildHeuristicOutput } from '../../src/modules/execution/heuristicFallback.ts'
import { validateOutput } from '../../src/modules/execution/outputValidator.ts'
import type { TaskProfile } from '../../src/types/profile.ts'

function cardsProfile(): TaskProfile {
  return JSON.parse(readFileSync('profiles/cards.json', 'utf8')) as TaskProfile
}

const input = {
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
}

test('fallback heurístico de cards escolhe o primeiro candidato e "-" para original', () => {
  const profile = cardsProfile()
  const output = buildHeuristicOutput(profile, input)
  assert.ok(output)
  assert.deepEqual(output, {
    items: [
      {
        item: 1,
        isProduct: true,
        title: 'A',
        price: 'A',
        original: '-',
        image: 'A',
        confidence: 40,
      },
    ],
  })
  const validation = validateOutput(profile, input, JSON.stringify(output))
  assert.equal(validation.ok, true)
})

test('fallback heurístico marca isProduct=false quando falta candidato obrigatório', () => {
  const profile = cardsProfile()
  const withoutTitle = {
    ...input,
    cards: [{ ...input.cards[0], titleCandidates: [] }],
  }
  const output = buildHeuristicOutput(profile, withoutTitle)
  assert.ok(output)
  const item = (output as { items: Array<Record<string, unknown>> }).items[0]
  assert.equal(item?.['isProduct'], false)
  assert.equal(item?.['title'], '-')
})
