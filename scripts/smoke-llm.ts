// Smoke test manual do pipeline HIBRIDO com o modelo real. Uso:
//   npm run model:smoke
// Requer LLM_PROVIDER=llamacpp e o GGUF em AI_MODEL_PATH.
//
// O pack abaixo tem:
//   c1: objetivo (1 titulo/1 preco) -> resolvido SEM modelo
//   c2: banner -> descartado SEM modelo
//   c3: 2 titulos plausiveis -> UNICA chamada ao modelo
//   c4: preco USD -> descartado SEM modelo
import { env } from '../src/config/env.ts'
import AdjudicationService from '../src/modules/adjudication/adjudicationService.ts'
import { disposeProviders, getProvider } from '../src/providers/llm/index.ts'
import type { AdjudicationPack } from '../src/types/adjudication.ts'

const pack: AdjudicationPack = {
  packVersion: env.PACK_VERSION,
  marketplace: 'amazon',
  packHash: null,
  cards: [
    {
      cardId: 'c1',
      host: 'amazon.com.br',
      titleCandidates: [{ id: 't1', text: 'Fone Bluetooth JBL Tune 510BT com 40h de bateria' }],
      priceCandidates: [
        { id: 'p1', text: 'R$ 199,90', currency: 'BRL', cents: 19990, kind: 'current' },
        { id: 'p2', text: 'R$ 249,90', currency: 'BRL', cents: 24990, kind: 'original' },
      ],
      imageCandidates: [{ id: 'i1', url: 'https://m.media-amazon.com/images/I/example.jpg' }],
      context: { position: 1, breadcrumb: 'Eletronicos > Audio' },
    },
    {
      cardId: 'c2',
      host: 'amazon.com.br',
      titleCandidates: [{ id: 't2', text: 'Frete GRATIS para todo o Brasil' }],
      priceCandidates: [{ id: 'p3', text: 'R$ 0,00', currency: 'BRL', cents: 0, kind: 'current' }],
      imageCandidates: [{ id: 'i2', url: 'https://m.media-amazon.com/images/I/banner.jpg' }],
      context: { position: 2, breadcrumb: 'Eletronicos > Audio' },
    },
    {
      cardId: 'c3',
      host: 'amazon.com.br',
      titleCandidates: [
        { id: 't3', text: 'Fone Bluetooth JBL Tune 510BT' },
        { id: 't4', text: 'Fone de ouvido sem fio JBL Tune 510BT original' },
      ],
      priceCandidates: [
        { id: 'p4', text: 'R$ 219,90', currency: 'BRL', cents: 21990, kind: 'current' },
      ],
      imageCandidates: [{ id: 'i3', url: 'https://m.media-amazon.com/images/I/jbl.jpg' }],
      context: { position: 3, breadcrumb: 'Eletronicos > Audio' },
    },
    {
      cardId: 'c4',
      host: 'amazon.com',
      titleCandidates: [{ id: 't5', text: 'Echo Dot 5a geracao smart speaker' }],
      priceCandidates: [{ id: 'p5', text: 'US$ 49,99', currency: 'USD', cents: 4999, kind: 'current' }],
      imageCandidates: [{ id: 'i4', url: 'https://m.media-amazon.com/images/I/echo.jpg' }],
      context: { position: 4, breadcrumb: 'Eletronicos > Casa' },
    },
  ],
}

async function main(): Promise<void> {
  console.log(`provider=${env.LLM_PROVIDER} model=${env.AI_MODEL_ID} path=${env.AI_MODEL_PATH}`)
  const provider = getProvider(null)
  const loadStarted = Date.now()
  await provider.load()
  console.log(`loaded em ${Date.now() - loadStarted}ms (ready=${await provider.isReady()})`)

  const started = Date.now()
  const result = await AdjudicationService.adjudicate(pack)
  console.log(`total=${Date.now() - started}ms mode=${result.mode} fallback=${result.fallbackReason}`)
  console.log(`decisions=${JSON.stringify(result.decisions)}`)
  console.log(`rejected=${JSON.stringify(result.rejected)}`)

  await disposeProviders()
}

main().catch((error) => {
  console.error('ERRO:', error)
  process.exitCode = 1
})
