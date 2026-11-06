// ============================================================================
// Referências de candidatos para perfis de seleção.
//
// O modelo NUNCA devolve IDs opacos nem valores: devolve letras fixas A-L (ou
// "-" para ausente). O servidor mapeia letra -> ID do candidato e revalida
// contra o input. O alfabeto fixo mantém o schema estável e cacheável.
// ============================================================================

export const NONE_LETTER = '-'

export const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'] as const

export const MAX_CANDIDATES = LETTERS.length

export type CandidateLetter = (typeof LETTERS)[number] | typeof NONE_LETTER

export function letterFor(index: number): CandidateLetter {
  return LETTERS[index] ?? NONE_LETTER
}

export function indexForLetter(letter: string): number {
  return LETTERS.indexOf(letter as (typeof LETTERS)[number])
}

export function isCandidateLetter(value: unknown): value is CandidateLetter {
  return value === NONE_LETTER || (typeof value === 'string' && indexForLetter(value) >= 0)
}
