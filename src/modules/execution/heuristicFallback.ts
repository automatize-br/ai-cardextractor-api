import { letterFor } from '../../providers/llm/candidateRef.ts'
import type { TaskProfile } from '../../types/profile.ts'

// ============================================================================
// Fallback determinístico genérico para perfis de seleção.
//
// Usado em `off`, `shadow` e quando o modelo falha/invalida um perfil com
// `validation.fallback=heuristic`. Escolhe o primeiro candidato de cada campo
// (e "-" para original, para não violar original>current). O resultado passa
// pelo MESMO validador do modelo; se não for válido, retorna null.
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collectionItems(input: unknown, collection: string): unknown[] {
  if (!isRecord(input)) return []
  const value = input[collection]
  return Array.isArray(value) ? value : []
}

function itemProperties(profile: TaskProfile): Record<string, unknown> | null {
  const output = profile.output.schema
  const properties = output['properties']
  if (!isRecord(properties)) return null
  const array = properties['items']
  if (!isRecord(array)) return null
  const itemSchema = array['items']
  if (!isRecord(itemSchema)) return null
  const itemProperties = itemSchema['properties']
  return isRecord(itemProperties) ? itemProperties : null
}

function confidenceValue(properties: Record<string, unknown>): number {
  const confidence = properties['confidence']
  if (isRecord(confidence) && confidence['maximum'] === 1) return 0.4
  return 40
}

export function buildHeuristicOutput(profile: TaskProfile, input: unknown): Record<string, unknown> | null {
  if (profile.mode !== 'selection') return null
  const properties = itemProperties(profile)
  if (!properties) return null
  const items = collectionItems(input, profile.input.collection)
  if (items.length === 0) return null

  const candidateFields = Object.entries(profile.validation.candidateFields)
  const outputItems: Record<string, unknown>[] = []

  for (let index = 0; index < items.length; index += 1) {
    const sourceItem = items[index]
    const source: Record<string, unknown> = isRecord(sourceItem) ? sourceItem : {}
    const item: Record<string, unknown> = {}

    if ('item' in properties) item['item'] = index + 1
    let isProduct = true

    for (const [field, collection] of candidateFields) {
      if (!(field in properties)) continue
      const candidates = source[collection]
      const hasCandidates = Array.isArray(candidates) && candidates.length > 0
      const isOriginal = field.toLowerCase().includes('original')
      if (isOriginal || !hasCandidates) {
        item[field] = '-'
        if (!isOriginal && ['title', 'price', 'image'].includes(field)) isProduct = false
        continue
      }
      item[field] = letterFor(0)
    }

    if ('isProduct' in properties) item['isProduct'] = isProduct
    if ('confidence' in properties) item['confidence'] = confidenceValue(properties)
    outputItems.push(item)
  }

  return { items: outputItems }
}
