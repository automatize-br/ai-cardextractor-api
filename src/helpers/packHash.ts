import { createHash } from 'node:crypto'

/**
 * JSON estavel: ordena chaves recursivamente para que o hash nao dependa da
 * ordem de insercao. Nao usa JSON.stringify direto (ordem de propriedades).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const parts: string[] = []
  for (const key of keys) {
    const item = record[key]
    if (item === undefined) continue
    parts.push(`${JSON.stringify(key)}:${stableStringify(item)}`)
  }
  return `{${parts.join(',')}}`
}

/** sha256 hex de um objeto/pack serializado de forma estavel. */
export function computePackHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

/**
 * Hash canônico genérico (perfil, prompt, schema, cacheKey).
 *
 * `stableStringify` ordena apenas chaves de objeto; arrays preservam a ordem,
 * porque a ordem é semântica (ex.: lista de candidatos).
 */
export function computeHash(value: unknown): string {
  return computePackHash(value)
}

export function shortHash(value: string, length = 12): string {
  return value.slice(0, Math.max(1, length))
}
