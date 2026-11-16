// Diagnóstico LOCAL — roda trimmer + extrator do worker nos HTMLs salvos
// (ok-informatica vs fail-celulares/eletronicos/games/bestsellers).
import { readFileSync } from 'node:fs'
import { trimHtmlForExtraction } from '../src/modules/remoteExtraction/htmlTrimmer.ts'
import { extractRawCards } from '../src/modules/extraction/extractCards.ts'
import { env } from '../src/config/env.ts'

const FILES: Array<[string, string]> = [
  ['ok-informatica', 'D:/MEUS_PROJETOS/AUTOMATIZE/API/tmp-html-ok-informatica.html'],
  ['fail-celulares', 'D:/MEUS_PROJETOS/AUTOMATIZE/API/tmp-html-fail-celulares.html'],
  ['fail-eletronicos', 'D:/MEUS_PROJETOS/AUTOMATIZE/API/tmp-html-fail-eletronicos.html'],
  ['fail-games', 'D:/MEUS_PROJETOS/AUTOMATIZE/API/tmp-html-fail-games.html'],
  ['fail-bestsellers', 'D:/MEUS_PROJETOS/AUTOMATIZE/API/tmp-html-fail-bestsellers.html'],
]

for (const [label, file] of FILES) {
  const html = readFileSync(file, 'utf8')
  const trimmed = trimHtmlForExtraction(html, env.EXTRACTOR_MAX_HTML_BYTES)
  const raw = extractRawCards(trimmed.html, 'amazon', 'https://www.amazon.com.br/s?k=x', 200)
  console.log(
    `${label}: html=${(html.length / 1024).toFixed(0)}KB · trimmed=${(trimmed.html.length / 1024).toFixed(0)}KB · tooLarge=${trimmed.tooLarge} · rawCards=${raw.cards.length} · truncated=${raw.truncated}`,
  )
  for (const c of raw.cards.slice(0, 2)) {
    console.log(`   · ${(c.title ?? '').slice(0, 50)} · ${c.priceCents} ${c.currency} · ${(c.permalink ?? '').slice(0, 60)}`)
  }
}
