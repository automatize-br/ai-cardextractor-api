import { validateJson } from '../../config/schema.ts'
import { indexForLetter, isCandidateLetter } from '../../providers/llm/candidateRef.ts'
import type { TaskProfile } from '../../types/profile.ts'
import { enforceRules } from './rules.ts'

// ============================================================================
// Validação pós-modelo v2:
// - schema de saída fechado;
// - cobertura exata de itens;
// - referências de candidato A-L válidas;
// - evidência (quote literal) para extração.
// ============================================================================

export interface OutputValidation {
  ok: boolean
  value: Record<string, unknown> | null
  errors: string[]
  evidenceCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function pointerSegments(sourceField: string): string[] {
  if (sourceField.startsWith('/')) {
    return sourceField
      .slice(1)
      .split('/')
      .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
  }
  if (sourceField === '') return []
  return sourceField
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((segment) => segment !== '')
}

function resolvePointer(root: unknown, sourceField: string): unknown {
  let current: unknown = root
  for (const segment of pointerSegments(sourceField)) {
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined
      current = current[index]
      continue
    }
    if (isRecord(current)) {
      if (!(segment in current)) return undefined
      current = current[segment]
      continue
    }
    return undefined
  }
  return current
}

function walkEvidence(value: unknown, input: unknown, errors: string[], state: { count: number }): void {
  if (Array.isArray(value)) {
    for (const item of value) walkEvidence(item, input, errors, state)
    return
  }
  if (!isRecord(value)) return

  const evidence = value['evidence']
  if (isRecord(evidence)) {
    const sourceField = evidence['sourceField']
    const quote = evidence['quote']
    if (typeof sourceField !== 'string' || sourceField.trim() === '') {
      errors.push('evidence.sourceField is required')
    } else if (typeof quote !== 'string' || quote.trim() === '') {
      errors.push('evidence.quote is required')
    } else {
      state.count += 1
      const raw = resolvePointer(input, sourceField)
      if (raw === undefined) {
        errors.push(`evidence.sourceField not found: ${sourceField}`)
      } else {
        const source = normalizeText(typeof raw === 'string' ? raw : JSON.stringify(raw))
        const normalizedQuote = normalizeText(quote)
        if (normalizedQuote.length < 8) {
          errors.push('evidence.quote is too short (min 8 chars)')
        } else if (!source.includes(normalizedQuote)) {
          errors.push(`evidence.quote not found in ${sourceField}`)
        }
      }
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'evidence') continue
    walkEvidence(child, input, errors, state)
  }
}

function validateCandidateReferences(
  profile: TaskProfile,
  input: unknown,
  output: Record<string, unknown>,
  errors: string[],
): void {
  const fields = Object.entries(profile.validation.candidateFields)
  if (fields.length === 0) return
  const outputItems = Array.isArray(output['items']) ? output['items'] : []
  const inputCollection = isRecord(input) ? input[profile.input.collection] : null
  const inputItems: unknown[] = Array.isArray(inputCollection) ? inputCollection : []

  for (const [index, rawItem] of outputItems.entries()) {
    if (!isRecord(rawItem)) continue
    const itemNumber = rawItem['item']
    const inputItem =
      typeof itemNumber === 'number' && Number.isInteger(itemNumber)
        ? inputItems[itemNumber - 1]
        : inputItems[index]
    if (!isRecord(inputItem)) continue

    for (const [field, collection] of fields) {
      const letter = rawItem[field]
      if (letter === undefined || letter === '-') continue
      if (!isCandidateLetter(letter)) {
        errors.push(`items[${index}].${field}: invalid candidate letter`)
        continue
      }
      const candidates = inputItem[collection]
      if (!Array.isArray(candidates)) {
        errors.push(`items[${index}].${field}: input collection "${collection}" not found`)
        continue
      }
      const candidateIndex = indexForLetter(letter)
      if (candidateIndex < 0 || candidateIndex >= candidates.length) {
        errors.push(`items[${index}].${field}: candidate ${letter} out of range`)
      }
    }
  }
}

function validateCoverage(
  profile: TaskProfile,
  input: unknown,
  output: Record<string, unknown>,
  errors: string[],
): void {
  if (profile.validation.coverage !== 'exact') return
  const inputCollection = isRecord(input) ? input[profile.input.collection] : null
  const inputItems: unknown[] | null = Array.isArray(inputCollection) ? inputCollection : null
  const outputItems: unknown[] | null = Array.isArray(output['items']) ? output['items'] : null
  if (!inputItems || !outputItems) return
  if (outputItems.length !== inputItems.length) {
    errors.push(`coverage: expected ${inputItems.length} items, received ${outputItems.length}`)
  }
  const seen = new Set<number>()
  for (const [index, rawItem] of outputItems.entries()) {
    if (!isRecord(rawItem)) {
      errors.push(`coverage: items[${index}] is not an object`)
      continue
    }
    const itemNumber = rawItem['item']
    if (typeof itemNumber !== 'number' || !Number.isInteger(itemNumber)) {
      errors.push(`coverage: items[${index}].item must be an integer`)
      continue
    }
    if (itemNumber < 1 || itemNumber > inputItems.length) {
      errors.push(`coverage: items[${index}].item out of range`)
      continue
    }
    if (seen.has(itemNumber)) errors.push(`coverage: duplicate item ${itemNumber}`)
    seen.add(itemNumber)
  }
  for (let item = 1; item <= inputItems.length; item += 1) {
    if (!seen.has(item)) errors.push(`coverage: missing item ${item}`)
  }
}

export function validateOutput(profile: TaskProfile, input: unknown, text: string): OutputValidation {
  const errors: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, value: null, errors: ['output is not valid JSON'], evidenceCount: 0 }
  }
  if (!isRecord(parsed)) {
    return { ok: false, value: null, errors: ['output must be a JSON object'], evidenceCount: 0 }
  }

  const schema = validateJson(profile.output.schema, parsed, `profile "${profile.id}" output.schema`)
  if (!schema.ok) errors.push(...schema.errors)

  validateCoverage(profile, input, parsed, errors)
  validateCandidateReferences(profile, input, parsed, errors)
  enforceRules(profile, input, parsed, errors)

  const evidenceState = { count: 0 }
  if (profile.validation.grounding === 'source_quotes') {
    walkEvidence(parsed, input, errors, evidenceState)
    if (evidenceState.count === 0) errors.push('grounding: at least one evidence object is required')
  }

  return {
    ok: errors.length === 0,
    value: parsed,
    errors,
    evidenceCount: evidenceState.count,
  }
}
