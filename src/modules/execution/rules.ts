import { indexForLetter, isCandidateLetter } from '../../providers/llm/candidateRef.ts'
import type { RuleConfig, TaskProfile } from '../../types/profile.ts'

// ============================================================================
// Regras declarativas e regras custom versionadas.
//
// Regras simples (required/enum/number_range/candidate_ref/unique/coverage)
// são executadas pelo tipo. Regras custom têm semântica versionada aqui e
// recebem parâmetros do perfil (.env).
// ============================================================================

export const KNOWN_CUSTOM_RULES = new Set([
  'current_price_brl',
  'original_gt_current',
  'unique_current_price',
  'title_min_length',
  'image_host_allowlist',
  'not_noise_title',
])

const SIMPLE_RULES = new Set(['required', 'enum', 'number_range', 'candidate_ref', 'unique', 'coverage'])

const NOISE_TITLE_LABELS = new Set([
  'patrocinado',
  'patrocinada',
  'publicidade',
  'anuncio',
  'sponsored',
  'advertisement',
  'frete gratis',
  'avaliacoes',
  'ver mais',
  'resultados',
  'recomendado para voce',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateRuleConfigs(rules: RuleConfig[], profileId: string): void {
  for (const rule of rules) {
    if (!SIMPLE_RULES.has(rule.type) && rule.type !== 'custom') {
      throw new Error(`profile "${profileId}": unknown rule type "${rule.type}"`)
    }
    if (rule.type === 'custom') {
      if (!rule.name || !KNOWN_CUSTOM_RULES.has(rule.name)) {
        throw new Error(`profile "${profileId}": unknown custom rule "${rule.name ?? '(missing)'}"`)
      }
    }
    if ((rule.type === 'required' || rule.type === 'enum' || rule.type === 'number_range' || rule.type === 'unique') && !rule.field) {
      throw new Error(`profile "${profileId}": rule "${rule.type}" requires field`)
    }
    if (rule.type === 'candidate_ref' && (!rule.field || !rule.collection)) {
      throw new Error(`profile "${profileId}": candidate_ref requires field and collection`)
    }
    if (rule.type === 'enum' && !Array.isArray(rule.params?.['values'])) {
      throw new Error(`profile "${profileId}": enum rule requires params.values`)
    }
  }
}

function outputItems(output: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(output['items']) ? output['items'].filter(isRecord) : []
}

function inputItems(input: unknown, collection: string): unknown[] {
  return isRecord(input) && Array.isArray(input[collection]) ? input[collection] : []
}

function inputItemFor(
  outputItem: Record<string, unknown>,
  items: unknown[],
  index: number,
): Record<string, unknown> | null {
  const itemNumber = outputItem['item']
  const candidate =
    typeof itemNumber === 'number' && Number.isInteger(itemNumber)
      ? items[itemNumber - 1]
      : items[index]
  return isRecord(candidate) ? candidate : null
}

function resolveCandidate(
  inputItem: Record<string, unknown>,
  collection: string,
  letter: unknown,
): Record<string, unknown> | null {
  if (!isCandidateLetter(letter) || letter === '-') return null
  const candidates = inputItem[collection]
  if (!Array.isArray(candidates)) return null
  const candidate = candidates[indexForLetter(letter)]
  return isRecord(candidate) ? candidate : null
}

function selectedCandidate(
  profile: TaskProfile,
  outputItem: Record<string, unknown>,
  inputItem: Record<string, unknown>,
  field: string,
): Record<string, unknown> | null {
  const collection = profile.validation.candidateFields[field]
  if (!collection) return null
  return resolveCandidate(inputItem, collection, outputItem[field])
}

function checkSimpleRule(
  rule: RuleConfig,
  outputItem: Record<string, unknown>,
  index: number,
  errors: string[],
): void {
  const field = rule.field ?? ''
  const value = outputItem[field]
  const isProduct = outputItem['isProduct']
  if (isProduct === false && rule.type === 'required') return

  switch (rule.type) {
    case 'required': {
      if (value === undefined || value === null || value === '' || value === '-') {
        errors.push(`items[${index}].${field}: required`)
      }
      return
    }
    case 'enum': {
      const values = rule.params?.['values']
      if (Array.isArray(values) && !values.includes(value)) {
        errors.push(`items[${index}].${field}: value not in enum`)
      }
      return
    }
    case 'number_range': {
      const min = Number(rule.params?.['min'] ?? Number.NEGATIVE_INFINITY)
      const max = Number(rule.params?.['max'] ?? Number.POSITIVE_INFINITY)
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        errors.push(`items[${index}].${field}: number out of range`)
      }
      return
    }
    case 'candidate_ref': {
      if (value === undefined || value === null) return
      if (value === '-') return
      if (!isCandidateLetter(value)) {
        errors.push(`items[${index}].${field}: invalid candidate letter`)
      }
      return
    }
    case 'coverage':
      return
    case 'unique':
      return
    default:
      return
  }
}

function checkCustomRule(
  profile: TaskProfile,
  rule: RuleConfig,
  outputItem: Record<string, unknown>,
  inputItem: Record<string, unknown> | null,
  index: number,
  errors: string[],
): void {
  if (outputItem['isProduct'] === false) return
  const name = rule.name ?? ''
  if (name === 'current_price_brl') {
    const price = inputItem ? selectedCandidate(profile, outputItem, inputItem, 'price') : null
    if (!price || price['currency'] !== 'BRL' || price['kind'] !== 'current') {
      errors.push(`items[${index}].price: must be current BRL`)
    }
    return
  }
  if (name === 'original_gt_current') {
    const current = inputItem ? selectedCandidate(profile, outputItem, inputItem, 'price') : null
    const original = inputItem ? selectedCandidate(profile, outputItem, inputItem, 'original') : null
    if (original) {
      const currentCents = typeof current?.['cents'] === 'number' ? current['cents'] : null
      const originalCents = typeof original['cents'] === 'number' ? original['cents'] : null
      if (currentCents === null || originalCents === null || originalCents <= currentCents) {
        errors.push(`items[${index}].original: must be greater than current price`)
      }
    }
    return
  }
  if (name === 'unique_current_price') {
    if (!inputItem) return
    const prices = inputItem['priceCandidates']
    if (!Array.isArray(prices)) return
    const values = new Set<number>()
    for (const price of prices) {
      if (!isRecord(price)) continue
      if (price['currency'] === 'BRL' && price['kind'] === 'current' && typeof price['cents'] === 'number') {
        values.add(price['cents'])
      }
    }
    if (values.size > 1) errors.push(`items[${index}].price: ambiguous current price`)
    return
  }
  if (name === 'title_min_length') {
    const title = inputItem ? selectedCandidate(profile, outputItem, inputItem, 'title') : null
    const min = Number(rule.params?.['minLength'] ?? 8)
    const text = typeof title?.['text'] === 'string' ? title['text'] : ''
    if (text.length < min) errors.push(`items[${index}].title: shorter than ${min}`)
    return
  }
  if (name === 'image_host_allowlist') {
    const image = inputItem ? selectedCandidate(profile, outputItem, inputItem, 'image') : null
    const hosts = rule.params?.['hosts']
    const url = typeof image?.['url'] === 'string' ? image['url'] : ''
    if (Array.isArray(hosts)) {
      let host = ''
      try {
        host = new URL(url).hostname
      } catch {
        host = ''
      }
      if (host === '' || !hosts.includes(host)) errors.push(`items[${index}].image: host not allowed`)
    }
    return
  }
  if (name === 'not_noise_title') {
    const title = inputItem ? selectedCandidate(profile, outputItem, inputItem, 'title') : null
    const text = typeof title?.['text'] === 'string' ? title['text'].trim().toLowerCase() : ''
    if (NOISE_TITLE_LABELS.has(text)) errors.push(`items[${index}].title: noise label`)
  }
}

export function enforceRules(
  profile: TaskProfile,
  input: unknown,
  output: Record<string, unknown>,
  errors: string[],
): void {
  const outputs = outputItems(output)
  const inputs = inputItems(input, profile.input.collection)

  for (const rule of profile.validation.rules) {
    if (rule.type === 'coverage') continue
    if (rule.type === 'unique') {
      const field = rule.field ?? ''
      const seen = new Set<string>()
      outputs.forEach((item, index) => {
        const value = item[field]
        if (value === undefined || value === null) return
        const key = JSON.stringify(value)
        if (seen.has(key)) errors.push(`items[${index}].${field}: duplicate value`)
        seen.add(key)
      })
      continue
    }

    outputs.forEach((item, index) => {
      checkSimpleRule(rule, item, index, errors)
      if (rule.type === 'custom') {
        checkCustomRule(profile, rule, item, inputItemFor(item, inputs, index), index, errors)
      }
    })
  }
}
