import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { stableStringify } from '../src/helpers/packHash.ts'

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : null
}

const file = arg('file')
if (!file) {
  console.error('Uso: npm run config:encode -- --file profiles/cards.json [--b64]')
  process.exit(1)
}

let parsed: unknown
try {
  parsed = JSON.parse(readFileSync(resolve(file), 'utf8'))
} catch (error) {
  console.error(`JSON inválido em ${file}: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}

// Aceita um perfil único ou um array de perfis; o runtime sempre lê array.
const payload = Array.isArray(parsed) ? parsed : [parsed]
const canonical = stableStringify(payload)
if (process.argv.includes('--b64')) {
  console.log(`AI_PROFILES_B64=${Buffer.from(canonical, 'utf8').toString('base64')}`)
} else {
  console.log(`AI_PROFILES_JSON=${canonical}`)
}
