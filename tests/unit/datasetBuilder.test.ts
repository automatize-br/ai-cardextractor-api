import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertBuildable,
  buildDataset,
  buildDatasetFromText,
  fnv1a,
  labelKey,
  parseReplays,
  splitFor,
} from '../../src/modules/dataset/datasetBuilder.ts'
import { ApiError } from '../../src/exceptions/ApiError.ts'
import { makeCard, makePack } from '../packFixture.ts'
import type { ReplayRecord } from '../../src/types/replay.ts'

function replay(overrides: Partial<ReplayRecord> = {}): ReplayRecord {
  const card = makeCard('c1', {
    titles: [
      { id: 't_c1', text: 'Fone Bluetooth JBL Tune 510BT' },
      { id: 't2', text: 'Fone de ouvido sem fio JBL Tune 510BT original' },
    ],
    images: [
      { id: 'i1', url: 'https://cdn.example.com/a.jpg' },
      { id: 'i2', url: 'https://cdn.example.com/b.jpg' },
    ],
  })
  return {
    capturedAt: '2026-10-21T10:00:00.000Z',
    packHash: 'a'.repeat(64),
    packVersion: '1',
    marketplace: 'amazon',
    mode: 'heuristic',
    modelId: 'qwen',
    modelVersion: 'qwen@1',
    promptVersion: '1',
    latencyMs: 100,
    pack: makePack([card]),
    decisions: [
      {
        cardId: 'c1',
        source: 'heuristic',
        isProduct: true,
        titleId: 't_c1',
        priceId: 'p_c1',
        originalPriceId: 'o_c1',
        imageId: 'i1',
        confidence: 0.4,
        needsReview: true,
        reviewReasons: ['ambiguous_title'],
      },
    ],
    rejected: [],
    shadow: [{ cardId: 'c1', isProduct: true, titleId: 't2', confidence: 0.8 }],
    ...overrides,
  }
}

function assistant(example: { messages: Array<{ role: string; content: string }> }): {
  d: Array<Record<string, unknown>>
} {
  const message = example.messages.find((item) => item.role === 'assistant')
  assert.ok(message)
  return JSON.parse(message.content) as { d: Array<Record<string, unknown>> }
}

test('usa a escolha shadow como rótulo (distilação) e letras do pack', () => {
  const result = buildDataset([replay()])
  assert.equal(result.examples.length, 1)
  const example = result.examples[0]
  assert.ok(example)

  const answer = assistant(example).d[0]
  assert.ok(answer)
  assert.equal(answer['p'], 1)
  assert.equal(answer['t'], 'B')
  assert.equal(answer['pr'], 'A')
  assert.equal(answer['o'], 'B')
  assert.equal(answer['i'], 'A')
  assert.equal(answer['cf'], 80)
  assert.equal(example.evalCase.expect.decisions['c1']?.titleId, 't2')
  assert.equal(result.stats.labelSources.shadow, 1)
})

test('correção humana tem prioridade sobre shadow/modelo', () => {
  const result = buildDataset([replay()], [
    { packHash: 'a'.repeat(64), cardId: 'c1', titleId: 't_c1' },
  ])
  const answer = assistant(result.examples[0]!).d[0]
  assert.equal(answer?.['t'], 'A')
  assert.equal(result.stats.labelSources.human, 1)
})

test('rótulo humano de rejeição gera p=0 e expect.rejected', () => {
  const result = buildDataset([replay()], [
    { packHash: 'a'.repeat(64), cardId: 'c1', reject: 'not_a_product' },
  ])
  const example = result.examples[0]
  assert.ok(example)
  const answer = assistant(example).d[0]
  assert.equal(answer?.['p'], 0)
  assert.equal(answer?.['t'], '-')
  assert.equal(example.evalCase.expect.rejected['c1'], 'not_a_product')
})

test('sem shadow/rótulo humano/modelo não gera exemplo', () => {
  const result = buildDataset([replay({ shadow: null })])
  assert.equal(result.examples.length, 0)
  assert.equal(result.stats.skippedCards, 1)
  assert.throws(
    () => assertBuildable(result),
    (error: unknown) => error instanceof ApiError && error.code === 'VALIDATION_ERROR',
  )
})

test('dedupe por packHash usa o replay mais recente e conta linhas inválidas', () => {
  const older = replay({ capturedAt: '2026-10-20T10:00:00.000Z' })
  const newer = replay({
    capturedAt: '2026-10-21T12:00:00.000Z',
    shadow: [{ cardId: 'c1', isProduct: true, titleId: 't_c1', confidence: 0.9 }],
  })
  const text = `${JSON.stringify(older)}\n${JSON.stringify(newer)}\n{quebrado}\n`
  const parsed = parseReplays(text)
  assert.equal(parsed.items.length, 2)
  assert.equal(parsed.invalid, 1)

  const built = buildDataset(parsed.items)
  assert.equal(built.examples.length, 1)
  assert.equal(built.stats.uniquePacks, 1)
  assert.equal(assistant(built.examples[0]!).d[0]?.['t'], 'A')
})

test('split por marketplace com 3+ domínios; fallback hash com menos', () => {
  const three = [
    replay({ packHash: '1'.repeat(64), marketplace: 'amazon' }),
    replay({ packHash: '2'.repeat(64), marketplace: 'shopee' }),
    replay({ packHash: '3'.repeat(64), marketplace: 'mercadolivre' }),
  ]
  const byDomain = buildDataset(three)
  assert.equal(byDomain.stats.splitStrategy, 'marketplace')

  const single = buildDataset([replay()])
  assert.equal(single.stats.splitStrategy, 'hash')
})

test('split e hash são determinísticos', () => {
  assert.equal(fnv1a('amazon'), fnv1a('amazon'))
  assert.equal(splitFor('abc'), splitFor('abc'))
  assert.ok(['train', 'valid', 'test'].includes(splitFor('abc')))
})

test('buildDatasetFromText soma inválidos de labels', () => {
  const built = buildDatasetFromText(JSON.stringify(replay()), `{ruim}\n`)
  assert.equal(built.invalidLabels, 1)
  assert.equal(built.examples.length, 1)
  assert.equal(built.stats.invalidLabels, 1)
  assert.equal(labelKey('h', 'c1'), 'h\u0000c1')
})
