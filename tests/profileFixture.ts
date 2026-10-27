import type { TaskProfile } from '../src/types/profile.ts'

export function makeProfile(overrides: Partial<TaskProfile> = {}): TaskProfile {
  const base: TaskProfile = {
    id: 'test-profile',
    version: '1.0.0',
    description: 'perfil de teste',
    mode: 'selection',
    input: {
      schema: {
        type: 'object',
        required: ['items'],
        properties: {
          items: { type: 'array', minItems: 1, maxItems: 30 },
        },
      },
      collection: 'items',
      maxItems: 30,
      maxChars: 50000,
    },
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
              required: ['item', 'choice', 'confidence'],
              properties: {
                item: { type: 'integer', minimum: 1, maximum: 30 },
                choice: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', '-'] },
                confidence: { type: 'integer', minimum: 0, maximum: 100 },
              },
            },
          },
        },
      },
    },
    prompt: {
      system: 'Escolha o melhor candidato. Responda apenas o JSON.',
      rules: ['Nunca invente valores.'],
      examples: [],
      userTemplate: '<INPUT>\n{{input}}\n</INPUT>\nResponda apenas o JSON.',
    },
    validation: {
      grounding: 'none',
      coverage: 'partial',
      candidateFields: {},
      rules: [],
      fallback: 'review',
      minConfidence: 0.6,
    },
    rulesVersion: '1',
    model: {
      id: 'fake-adjudicator',
      allowedModels: ['fake-adjudicator'],
      temperature: 0,
      maxTokens: 256,
      timeoutMs: 1000,
      batchSize: 10,
      structuredOutput: 'json_schema',
    },
    cache: {
      appTtlMs: 60000,
      promptPrefix: true,
      storeQuotes: true,
      maxPromptCacheBlocks: 1,
    },
  }
  return { ...base, ...overrides }
}
