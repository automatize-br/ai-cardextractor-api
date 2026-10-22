import { timingSafeEqual } from 'node:crypto'

/**
 * Compara duas strings em tempo constante. Retorna false para tipos/tamanhos
 * diferentes sem curto-circuito observavel (compara buffers de tamanho igual).
 */
export function safeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    // Compara contra si mesmo para gastar tempo equivalente e evitar oraculo.
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}
