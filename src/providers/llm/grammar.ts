// ============================================================================
// Gramatica GBNF ESTATICA (nunca gerada por request).
//
// Formato compacto — o modelo escolhe LETRAS, nao IDs:
//   {"d":[{"c":1,"p":1,"t":"A","pr":"A","o":"B","i":"A","cf":90}]}
//
//   c  = numero do card (1-based)
//   p  = 1 (produto) | 0 (nao-produto)
//   t/pr/o/i = letra do candidato (A..L) ou "-"
//   cf = confianca 0..100
//
// Letras reduzem drasticamente a chance de o modelo 0.5B "copiar" texto ou
// inventar IDs. O servidor faz o mapeamento letra -> ID opaco.
// ============================================================================

export const RESPONSE_GRAMMAR = String.raw`
root   ::= ws "{" ws "\"d\":" ws "[" ws (item (ws "," ws item)*)? ws "]" ws "}" ws
item   ::= "{" ws "\"c\":" num ws "," ws "\"p\":" flag ws "," ws "\"t\":\"" letter "\"" ws "," ws "\"pr\":\"" letter "\"" ws "," ws "\"o\":\"" letter "\"" ws "," ws "\"i\":\"" letter "\"" ws "," ws "\"cf\":" num ws "}"
flag   ::= [01]
letter ::= [A-L] | "-"
num    ::= [0-9]+
ws     ::= [ \t]*
`.trim()

export const NONE_LETTER = '-'
export const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'] as const

export function letterFor(index: number): string {
  return LETTERS[index] ?? '-'
}

export function indexForLetter(letter: string): number {
  return LETTERS.indexOf(letter as (typeof LETTERS)[number])
}
