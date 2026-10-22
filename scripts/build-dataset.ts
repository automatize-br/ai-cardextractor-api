// Monta o dataset de treino (F6) a partir dos replays shadow (JSONL) e de um
// arquivo OPCIONAL de correções humanas:
//
//   npm run dataset:build
//   npm run dataset:build -- --in data/replays.jsonl --labels data/labels.jsonl
//   npm run dataset:build -- --out data/dataset --strategy marketplace
//
// Saída:
//   <out>/train.jsonl  <out>/valid.jsonl  <out>/test.jsonl   (messages p/ SFT)
//   <out>/test.eval.jsonl                                     (formato do eval)
//   <out>/stats.json
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertBuildable, buildDatasetFromText } from '../src/modules/dataset/datasetBuilder.ts'
import type { DatasetExample, SplitName } from '../src/modules/dataset/datasetBuilder.ts'

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : fallback
}

function readOptional(path: string): string {
  const full = resolve(path)
  return existsSync(full) ? readFileSync(full, 'utf8') : ''
}

function writeJsonl(path: string, items: unknown[]): void {
  const body = items.map((item) => JSON.stringify(item)).join('\n')
  writeFileSync(path, body === '' ? '' : `${body}\n`, 'utf8')
}

function main(): void {
  const input = argValue('in', 'data/replays.jsonl')
  const labelsPath = argValue('labels', '')
  const outDir = resolve(argValue('out', 'data/dataset'))
  const strategyArg = argValue('strategy', 'auto')
  const splitStrategy =
    strategyArg === 'marketplace' || strategyArg === 'hash' ? strategyArg : 'auto'

  const inputPath = resolve(input)
  if (!existsSync(inputPath)) {
    console.error(`Arquivo de replays não encontrado: ${inputPath}`)
    console.error('Ative AI_REPLAY_PATH e rode em shadow/assist, ou use --in <arquivo.jsonl>.')
    process.exitCode = 1
    return
  }

  const replaysText = readFileSync(inputPath, 'utf8')
  const labelsText = labelsPath === '' ? '' : readOptional(labelsPath)
  const built = buildDatasetFromText(replaysText, labelsText, { splitStrategy })
  try {
    assertBuildable(built)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
    return
  }

  mkdirSync(outDir, { recursive: true })
  const splits: SplitName[] = ['train', 'valid', 'test']
  for (const split of splits) {
    const items = built.examples
      .filter((example) => example.split === split)
      .map((example: DatasetExample) => ({
        messages: example.messages,
        meta: { packHash: example.packHash, marketplace: example.marketplace },
      }))
    writeJsonl(join(outDir, `${split}.jsonl`), items)
  }
  writeJsonl(
    join(outDir, 'test.eval.jsonl'),
    built.examples.filter((example) => example.split === 'test').map((example) => example.evalCase),
  )
  writeFileSync(join(outDir, 'stats.json'), `${JSON.stringify(built.stats, null, 2)}\n`, 'utf8')

  console.log(`replays=${built.stats.replays} packs=${built.stats.uniquePacks} exemplos=${built.stats.examples}`)
  console.log(
    `cards=${built.stats.cards} rotulados=${built.stats.labeledCards} ignorados=${built.stats.skippedCards}`,
  )
  console.log(
    `split=${built.stats.splitStrategy} train=${built.stats.splits.train} valid=${built.stats.splits.valid} test=${built.stats.splits.test}`,
  )
  console.log(
    `labels: human=${built.stats.labelSources.human} shadow=${built.stats.labelSources.shadow} model=${built.stats.labelSources.model}` +
      ` | inválidos: replays=${built.invalidReplays} labels=${built.invalidLabels}`,
  )
  console.log(`saída: ${outDir}`)
  if (built.stats.splits.valid === 0 || built.stats.splits.test === 0) {
    console.warn('Aviso: split valid/test vazio — colete mais domínios/packs antes de treinar.')
  }
}

main()
