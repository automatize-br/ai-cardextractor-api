#!/usr/bin/env node
// Runner dos testes: descobre *.test.ts nos diretorios informados e chama o
// test runner do Node com tsx + setup. Sem modelo real e sem rede.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const directories = process.argv.slice(2)

if (directories.length === 0) {
  console.error('Uso: node scripts/run-tests.mjs <diretorio> [<diretorio>...]')
  process.exit(1)
}

const files = []
for (const directory of directories) {
  if (!existsSync(directory)) continue
  for (const entry of readdirSync(directory)) {
    if (entry.endsWith('.test.ts')) files.push(join(directory, entry))
  }
}

if (files.length === 0) {
  console.error(`Nenhum arquivo *.test.ts encontrado em: ${directories.join(', ')}`)
  process.exit(1)
}

files.sort()

const args = [
  '--import',
  'tsx',
  '--import',
  './tests/setup.ts',
  '--test',
  '--test-concurrency=4',
  ...files,
]

console.log(`> ${files.length} arquivo(s) de teste: ${directories.join(', ')}\n`)

const child = spawn(process.execPath, args, { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
