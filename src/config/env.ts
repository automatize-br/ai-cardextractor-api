import dotenv from 'dotenv'
dotenv.config()

function readString(name: string, fallback = ''): string {
  const raw = process.env[name]
  return raw === undefined ? fallback : raw.trim()
}

function readInt(name: string, fallback: number): number {
  const raw = readString(name)
  if (raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer — received "${raw}"`)
  }
  return parsed
}

function readFloat(name: string, fallback: number): number {
  const raw = readString(name)
  if (raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number — received "${raw}"`)
  }
  return parsed
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = readString(name).toLowerCase()
  if (raw === '') return fallback
  if (['true', '1', 'yes', 'on'].includes(raw)) return true
  if (['false', '0', 'no', 'off'].includes(raw)) return false
  throw new Error(`${name} must be a boolean (true/false) — received "${raw}"`)
}

function readCsv(name: string): string[] {
  return readString(name)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

function readPersistence(): 'memory' | 'mongo' {
  const value = readString('AI_PERSISTENCE', 'memory').toLowerCase()
  if (value !== 'memory' && value !== 'mongo') {
    throw new Error(`AI_PERSISTENCE must be "memory" or "mongo" — received "${value}"`)
  }
  return value
}

function readLlmProvider(): 'fake' | 'llamacpp' | 'http' {
  const value = readString('LLM_PROVIDER', 'fake').toLowerCase()
  if (value !== 'fake' && value !== 'llamacpp' && value !== 'http') {
    throw new Error(`LLM_PROVIDER must be "fake", "llamacpp" or "http" — received "${value}"`)
  }
  return value
}

export const env = {
  PORT: readInt('PORT', 5555),
  // Bind local por padrao: o servico nao deve ficar exposto sem proxy/allowlist.
  HOST: readString('HOST', '127.0.0.1'),
  ENVIRONMENT: readString('ENVIRONMENT'),
  TRUST_PROXY: readString('TRUST_PROXY'),
  CORS_ORIGINS: readCsv('CORS_ORIGINS'),

  AI_INTERNAL_KEY: readString('AI_INTERNAL_KEY'),
  AI_PERSISTENCE: readPersistence(),
  AI_STORE_PACKS: readBoolean('AI_STORE_PACKS', false),
  AI_ADJ_MODE: readString('AI_ADJ_MODE', 'off'),
  AI_MIN_CONFIDENCE: readFloat('AI_MIN_CONFIDENCE', 0.6),

  // Versoes carimbadas em cada resposta/registro. Mudar o prompt ou o formato
  // do pack exige incrementar a env correspondente (nunca hardcode).
  PACK_VERSION: readString('PACK_VERSION', '1'),
  PROMPT_VERSION: readString('PROMPT_VERSION', '1'),

  MONGO_URI: readString('MONGO_URI'),
  MONGO_USER: readString('MONGO_USER'),
  MONGO_PASSWORD: readString('MONGO_PASSWORD'),
  MONGO_URL: readString('MONGO_URL'),
  MONGO_ENVIRONMENT: readString('MONGO_ENVIRONMENT'),

  LLM_PROVIDER: readLlmProvider(),
  LLM_TIMEOUT_MS: readInt('LLM_TIMEOUT_MS', 12000),
  // Um load travado nao pode ocupar a fila para sempre.
  LLM_LOAD_TIMEOUT_MS: readInt('LLM_LOAD_TIMEOUT_MS', 60000),
  LLM_CHUNK_SIZE: readInt('LLM_CHUNK_SIZE', 2),
  LLM_MAX_QUEUE: readInt('LLM_MAX_QUEUE', 8),
  LLM_MAX_CARDS: readInt('LLM_MAX_CARDS', 30),
  LLM_MAX_TOKENS: readInt('LLM_MAX_TOKENS', 700),
  LLM_TEMPERATURE: readFloat('LLM_TEMPERATURE', 0),

  AI_MODEL_ID: readString('AI_MODEL_ID', 'qwen2.5-0.5b-instruct-q4_k_m'),
  AI_MODEL_VERSION: readString('AI_MODEL_VERSION'),
  AI_MODEL_PATH: readString('AI_MODEL_PATH', 'src/models/qwen2.5-0.5b-instruct-q4_k_m.gguf'),
  AI_MODEL_CONTEXT: readInt('AI_MODEL_CONTEXT', 2048),
  AI_MODEL_THREADS: readInt('AI_MODEL_THREADS', 0),
  AI_MODELS_JSON: readString('AI_MODELS_JSON'),

  LLM_HTTP_BASE_URL: readString('LLM_HTTP_BASE_URL'),
  LLM_HTTP_API_KEY: readString('LLM_HTTP_API_KEY'),
  LLM_HTTP_MODEL: readString('LLM_HTTP_MODEL'),
} as const

export function isTestEnvironment(): boolean {
  const value = env.ENVIRONMENT.toLowerCase()
  return value === 'test' || value === 'testing'
}

export function isDevelopmentEnvironment(): boolean {
  const value = env.ENVIRONMENT.toLowerCase()
  return value === '' || value === 'dev' || value === 'development' || isTestEnvironment()
}

export function isProductionEnvironment(): boolean {
  return !isDevelopmentEnvironment()
}

export type AdjMode = 'off' | 'shadow' | 'assist' | 'on'

/**
 * Kill switch lido a CADA request (nao congelado no boot), para permitir
 * desligar o modelo sem restart em producao.
 */
export function getAdjMode(): AdjMode {
  const value = (process.env['AI_ADJ_MODE'] ?? 'off').trim().toLowerCase()
  if (value === 'shadow' || value === 'assist' || value === 'on') return value
  return 'off'
}
