import dotenv from 'dotenv'

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : null
}

const envFile = arg('env')
if (envFile) dotenv.config({ path: envFile })
else dotenv.config()

const json = (process.env['AI_PROFILES_JSON'] ?? '').trim()
const b64 = (process.env['AI_PROFILES_B64'] ?? '').trim()
const text = json !== '' ? json : b64 !== '' ? Buffer.from(b64, 'base64').toString('utf8') : ''

if (text === '') {
  console.error('AI_PROFILES_JSON/AI_PROFILES_B64 vazio')
  process.exit(1)
}

try {
  console.log(JSON.stringify(JSON.parse(text), null, 2))
} catch (error) {
  console.error(`Perfis inválidos: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
