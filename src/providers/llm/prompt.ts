import type { AdjudicationPack } from '../../types/adjudication.ts'
import { letterFor } from './grammar.ts'

// ============================================================================
// Prompt do adjudicador (modelo 0.5B, CPU, contexto 2048).
//
// Candidatos sao rotulados com LETRAS (A, B, C...) por campo. O modelo nunca
// ve nem devolve IDs opacos — apenas escolhe a letra. Isso evita que um modelo
// pequeno copie texto/preco para o campo de ID.
//
// Formato por card:
//   card 1 (id=c1) host=amazon.com.br pos=1 cat=Audio
//    T A="titulo"
//    P A moeda=BRL centavos=19990 tipo=current
//    I A
// ============================================================================

export const SYSTEM_PROMPT = [
  'Voce adjudica ofertas de e-commerce.',
  'Cada card lista candidatos rotulados com LETRAS: T (titulo), P (preco), I (imagem).',
  'Responda com o NUMERO do card (c) e a LETRA do melhor candidato em cada campo.',
  'Exemplo: {"d":[{"c":1,"p":1,"t":"B","pr":"A","o":"C","i":"A","cf":90}]}',
  'Use p=1 para produto e p=0 para banner/avaliacao/frete; com p=0 use "-" em tudo.',
  'Se faltar titulo, preco atual em BRL ou imagem, use p=0.',
  'Nunca escreva titulos, precos ou URLs. Apenas letras A-L ou "-".',
  'Responda APENAS o JSON compacto, sem explicacoes.',
].join(' ')

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').replace(/"/g, "'").trim()
  return clean.length <= max ? clean : `${clean.slice(0, max)}...`
}

function sanitizeBreadcrumb(value: string | null): string {
  if (!value) return '-'
  return truncate(value, 50)
}

export function buildUserPrompt(pack: AdjudicationPack): string {
  const lines: string[] = [`marketplace=${pack.marketplace}`, 'cards:']

  pack.cards.forEach((card, cardIndex) => {
    const position = card.context.position === null ? '-' : String(card.context.position)
    lines.push(
      `card ${cardIndex + 1} (id=${card.cardId}) host=${card.host} pos=${position} cat=${sanitizeBreadcrumb(card.context.breadcrumb)}`,
    )
    card.titleCandidates.forEach((title, index) => {
      lines.push(` T ${letterFor(index)}="${truncate(title.text, 100)}"`)
    })
    card.priceCandidates.forEach((price, index) => {
      lines.push(
        ` P ${letterFor(index)} moeda=${price.currency} centavos=${price.cents} tipo=${price.kind} texto="${truncate(price.text, 24)}"`,
      )
    })
    card.imageCandidates.forEach((_image, index) => {
      lines.push(` I ${letterFor(index)}`)
    })
  })

  const total = pack.cards.length
  lines.push(
    `responda exatamente ${total} ${total === 1 ? 'item' : 'itens'}: um para CADA card c=1..${total}, na ordem, sem repetir.`,
  )
  lines.push('formato: {"d":[{"c":1,"p":1,"t":"A","pr":"A","o":"-","i":"A","cf":90}]}')
  return lines.join('\n')
}
