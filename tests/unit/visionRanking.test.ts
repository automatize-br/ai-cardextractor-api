import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { FakeVisionProvider } from '../../src/providers/vision/fakeVisionProvider.ts'
import { resetVisionProvidersForTests } from '../../src/providers/vision/index.ts'
import AdjudicationService from '../../src/modules/adjudication/adjudicationService.ts'
import { rankImageCandidates } from '../../src/modules/adjudication/visionRanking.ts'
import { makeCard, makePack } from '../packFixture.ts'
import type { VisionProvider, VisionScoreInput } from '../../src/providers/vision/types.ts'

const originalVision = process.env['VISION_PROVIDER']
const originalMode = process.env['AI_ADJ_MODE']

function cardWithImages(): ReturnType<typeof makeCard> {
  return makeCard('c1', {
    images: [
      { id: 'i1', url: 'https://cdn.example.com/generic.jpg' },
      { id: 'i2', url: 'https://cdn.example.com/preferred-product.jpg' },
    ],
  })
}

beforeEach(() => {
  resetVisionProvidersForTests()
})

afterEach(() => {
  resetVisionProvidersForTests()
  if (originalVision === undefined) delete process.env['VISION_PROVIDER']
  else process.env['VISION_PROVIDER'] = originalVision
  if (originalMode === undefined) delete process.env['AI_ADJ_MODE']
  else process.env['AI_ADJ_MODE'] = originalMode
})

test('reordena imagens pelo score do provider (fake)', async () => {
  const card = cardWithImages()
  const changed = await rankImageCandidates([card], new FakeVisionProvider(), {
    minScore: 0,
    timeoutMs: 500,
  })
  assert.equal(changed, 1)
  assert.deepEqual(
    card.imageCandidates.map((image) => image.id),
    ['i2', 'i1'],
  )
})

test('falha do provider mantém a ordem determinística', async () => {
  const card = cardWithImages()
  const failing: VisionProvider = {
    name: 'boom',
    isReady: async () => true,
    score: async () => {
      throw new Error('offline')
    },
    dispose: async () => undefined,
  }
  const changed = await rankImageCandidates([card], failing, { minScore: 0, timeoutMs: 500 })
  assert.equal(changed, 0)
  assert.deepEqual(
    card.imageCandidates.map((image) => image.id),
    ['i1', 'i2'],
  )
})

test('score abaixo do mínimo não reordena', async () => {
  const card = cardWithImages()
  const changed = await rankImageCandidates([card], new FakeVisionProvider(), {
    minScore: 0.95,
    timeoutMs: 500,
  })
  assert.equal(changed, 0)
  assert.equal(card.imageCandidates[0]?.id, 'i1')
})

test('imagens não-http são ignoradas e card com 1 imagem nem chama o provider', async () => {
  let calls = 0
  const spy: VisionProvider = {
    name: 'spy',
    isReady: async () => true,
    score: async (input: VisionScoreInput) => {
      calls += 1
      return input.images.map(() => 0.5)
    },
    dispose: async () => undefined,
  }
  const single = makeCard('c1')
  const dataOnly = makeCard('c2', {
    images: [
      { id: 'i1', url: 'data:image/png;base64,aaa' },
      { id: 'i2', url: 'data:image/png;base64,bbb' },
    ],
  })
  const changed = await rankImageCandidates([single, dataOnly], spy, { minScore: 0, timeoutMs: 500 })
  assert.equal(changed, 0)
  assert.equal(calls, 0)
})

test('adjudicação usa a visão para escolher a melhor imagem (sem modelo)', async () => {
  process.env['VISION_PROVIDER'] = 'fake'
  process.env['AI_ADJ_MODE'] = 'off'
  resetVisionProvidersForTests()

  const pack = makePack([cardWithImages()])
  const result = await AdjudicationService.adjudicate(pack)
  assert.equal(result.mode, 'heuristic')
  assert.equal(result.decisions[0]?.imageId, 'i2')
  assert.equal(result.decisions[0]?.titleId, 't_c1')
})
