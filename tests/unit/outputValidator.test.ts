import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateOutput } from '../../src/modules/execution/outputValidator.ts'
import type { TaskProfile } from '../../src/types/profile.ts'
import { makeProfile } from '../profileFixture.ts'

const input = { items: [{ rawText: 'Produto R$ 199,90', candidates: [{ id: 'a' }, { id: 'b' }] }] }

test('schema válido e candidato dentro da faixa passam', () => {
  const profile = makeProfile({
    validation: {
      ...makeProfile().validation,
      coverage: 'exact',
      candidateFields: { choice: 'candidates' },
    },
  })
  const result = validateOutput(
    profile,
    input,
    JSON.stringify({ items: [{ item: 1, choice: 'B', confidence: 90 }] }),
  )
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
})

test('candidato fora da faixa é rejeitado', () => {
  const profile = makeProfile({
    validation: {
      ...makeProfile().validation,
      candidateFields: { choice: 'candidates' },
    },
  })
  const result = validateOutput(
    profile,
    input,
    JSON.stringify({ items: [{ item: 1, choice: 'C', confidence: 90 }] }),
  )
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('out of range')))
})

test('cobertura exata rejeita item omitido', () => {
  const profile = makeProfile({
    validation: { ...makeProfile().validation, coverage: 'exact' },
  })
  const result = validateOutput(
    profile,
    { items: [{}, {}] },
    JSON.stringify({ items: [{ item: 1, choice: 'A', confidence: 90 }] }),
  )
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('coverage: expected 2')))
  assert.ok(result.errors.some((error) => error.includes('coverage: missing item 2')))
})

test('evidência com quote literal válida passa', () => {
  const profile = extractionProfile()
  const result = validateOutput(
    profile,
    input,
    JSON.stringify({
      items: [
        {
          field: 'price',
          value: 199.9,
          evidence: { sourceField: 'items[0].rawText', quote: 'R$ 199,90' },
        },
      ],
    }),
  )
  assert.equal(result.ok, true)
  assert.equal(result.evidenceCount, 1)
})

test('evidência com quote falsa ou curta é rejeitada', () => {
  const profile = extractionProfile()
  const fake = validateOutput(
    profile,
    input,
    JSON.stringify({
      items: [
        {
          field: 'price',
          value: 199.9,
          evidence: { sourceField: 'items[0].rawText', quote: 'R$ 111,11' },
        },
      ],
    }),
  )
  assert.equal(fake.ok, false)
  assert.ok(fake.errors.some((error) => error.includes('not found')))

  const short = validateOutput(
    profile,
    input,
    JSON.stringify({
      items: [
        {
          field: 'price',
          value: 199.9,
          evidence: { sourceField: 'items[0].rawText', quote: 'R$' },
        },
      ],
    }),
  )
  assert.equal(short.ok, false)
  assert.ok(short.errors.some((error) => error.includes('too short')))
})

test('regras custom de cards validam preço atual, original e ambiguidade', () => {
  const profile = cardsProfile()
  const validInput = {
    items: [
      {
        titleCandidates: [{ text: 'Fone Bluetooth JBL Tune 510BT' }],
        priceCandidates: [
          { currency: 'BRL', kind: 'current', cents: 19990 },
          { currency: 'BRL', kind: 'original', cents: 24990 },
        ],
        imageCandidates: [{ url: 'https://m.media-amazon.com/images/I/x.jpg' }],
      },
    ],
  }
  const valid = validateOutput(
    profile,
    validInput,
    JSON.stringify({
      items: [{ item: 1, isProduct: true, title: 'A', price: 'A', original: 'B', image: 'A', confidence: 90 }],
    }),
  )
  assert.equal(valid.ok, true)

  const wrongOriginal = validateOutput(
    profile,
    validInput,
    JSON.stringify({
      items: [{ item: 1, isProduct: true, title: 'A', price: 'A', original: 'A', image: 'A', confidence: 90 }],
    }),
  )
  assert.equal(wrongOriginal.ok, false)
  assert.ok(wrongOriginal.errors.some((error) => error.includes('greater than current')))

  const wrongPrice = validateOutput(
    profile,
    validInput,
    JSON.stringify({
      items: [{ item: 1, isProduct: true, title: 'A', price: 'B', original: 'B', image: 'A', confidence: 90 }],
    }),
  )
  assert.equal(wrongPrice.ok, false)
  assert.ok(wrongPrice.errors.some((error) => error.includes('current BRL')))

  const ambiguousInput = {
    items: [
      {
        titleCandidates: [{ text: 'Fone Bluetooth JBL Tune 510BT' }],
        priceCandidates: [
          { currency: 'BRL', kind: 'current', cents: 19990 },
          { currency: 'BRL', kind: 'current', cents: 20990 },
          { currency: 'BRL', kind: 'original', cents: 24990 },
        ],
        imageCandidates: [{ url: 'https://m.media-amazon.com/images/I/x.jpg' }],
      },
    ],
  }
  const ambiguous = validateOutput(
    profile,
    ambiguousInput,
    JSON.stringify({
      items: [{ item: 1, isProduct: true, title: 'A', price: 'A', original: 'C', image: 'A', confidence: 90 }],
    }),
  )
  assert.equal(ambiguous.ok, false)
  assert.ok(ambiguous.errors.some((error) => error.includes('ambiguous current price')))
})

test('grounding source_quotes exige ao menos uma evidência', () => {
  const profile = extractionProfile()
  const result = validateOutput(
    profile,
    input,
    JSON.stringify({ items: [{ field: 'price', value: 199.9 }] }),
  )
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('at least one evidence')))
})

function cardsProfile(): TaskProfile {
  const base = makeProfile()
  const letters = { type: 'string', enum: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', '-'] }
  return makeProfile({
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['item', 'isProduct', 'title', 'price', 'original', 'image', 'confidence'],
              properties: {
                item: { type: 'integer', minimum: 1 },
                isProduct: { type: 'boolean' },
                title: letters,
                price: letters,
                original: letters,
                image: letters,
                confidence: { type: 'integer', minimum: 0, maximum: 100 },
              },
            },
          },
        },
      },
    },
    validation: {
      ...base.validation,
      candidateFields: {
        title: 'titleCandidates',
        price: 'priceCandidates',
        original: 'priceCandidates',
        image: 'imageCandidates',
      },
      rules: [
        { type: 'required', field: 'title' },
        { type: 'custom', name: 'current_price_brl' },
        { type: 'custom', name: 'original_gt_current' },
        { type: 'custom', name: 'unique_current_price' },
      ],
    },
  })
}

function extractionProfile(): TaskProfile {
  const evidenceSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['field', 'value', 'evidence'],
    properties: {
      field: { type: 'string' },
      value: { type: 'number' },
      evidence: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceField', 'quote'],
        properties: {
          sourceField: { type: 'string' },
          quote: { type: 'string' },
        },
      },
    },
  }
  return makeProfile({
    mode: 'extraction',
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: {
          items: { type: 'array', minItems: 1, items: evidenceSchema },
        },
      },
    },
    validation: {
      ...makeProfile().validation,
      grounding: 'source_quotes',
      coverage: 'partial',
    },
  })
}
