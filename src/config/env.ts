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

  // Config v2. Defaults seguros: sem AI_MODE explícito o modelo fica desligado.
  AI_CONFIG_VERSION: readString('AI_CONFIG_VERSION', '2'),
  AI_ENGINE_VERSION: readString('AI_ENGINE_VERSION', '2'),
  AI_DEFAULT_PROFILE: readString('AI_DEFAULT_PROFILE', 'cards'),
  AI_DEFAULT_MODEL: readString('AI_DEFAULT_MODEL', ''),
  AI_MODE: readString('AI_MODE', ''),
  AI_FAIL_OPEN: readBoolean('AI_FAIL_OPEN', true),
  AI_TIMEOUT_MS: readInt('AI_TIMEOUT_MS', 30000),
  AI_LEGACY_TIMEOUT_MS: readInt('AI_LEGACY_TIMEOUT_MS', readInt('LLM_TIMEOUT_MS', 5000)),
  AI_MAX_ITEMS: readInt('AI_MAX_ITEMS', readInt('LLM_MAX_CARDS', 30)),
  AI_MAX_INPUT_CHARS: readInt('AI_MAX_INPUT_CHARS', 50000),
  AI_MAX_OUTPUT_TOKENS: readInt('AI_MAX_OUTPUT_TOKENS', readInt('LLM_MAX_TOKENS', 2048)),
  AI_MAX_CONCURRENT_PROVIDER_CALLS: readInt(
    'AI_MAX_CONCURRENT_PROVIDER_CALLS',
    readInt('LLM_MAX_QUEUE', 4),
  ),
  AI_BATCH_SIZE: readInt('AI_BATCH_SIZE', 10),
  AI_LEGACY_BATCH_SIZE: readInt('AI_LEGACY_BATCH_SIZE', readInt('LLM_CHUNK_SIZE', 2)),
  AI_TEMPERATURE: readFloat('AI_TEMPERATURE', readFloat('LLM_TEMPERATURE', 0)),
  AI_TOP_P: readFloat('AI_TOP_P', 1),
  AI_SEED: readInt('AI_SEED', 42),
  AI_MAX_RETRIES: readInt('AI_MAX_RETRIES', 1),
  AI_LOG_PROMPTS: readBoolean('AI_LOG_PROMPTS', readBoolean('LLM_DEBUG_PROMPT', false)),
  AI_APP_CACHE: readString('AI_APP_CACHE', 'memory'),
  AI_APP_CACHE_TTL_MS: readInt('AI_APP_CACHE_TTL_MS', 86_400_000),
  AI_APP_CACHE_MAX: readInt('AI_APP_CACHE_MAX', 5000),
  AI_APP_CACHE_STORE_QUOTES: readBoolean('AI_APP_CACHE_STORE_QUOTES', true),
  AI_REDIS_URL: readString('AI_REDIS_URL'),
  AI_PROMPT_CACHE: readString('AI_PROMPT_CACHE', 'auto'),
  AI_PROMPT_CACHE_TTL: readString('AI_PROMPT_CACHE_TTL', '1h'),
  AI_PROMPT_CACHE_MAX_BLOCKS: readInt('AI_PROMPT_CACHE_MAX_BLOCKS', 1),
  AI_ALLOW_INSECURE_LLM_URL: readBoolean('AI_ALLOW_INSECURE_LLM_URL', false),
  AI_DEBUG: readBoolean('AI_DEBUG', readBoolean('LLM_DEBUG', false)),
  AI_REPLAY_STORE_PACK: readBoolean('AI_REPLAY_STORE_PACK', false),
  AI_PROFILES_JSON: readString('AI_PROFILES_JSON'),
  AI_PROFILES_B64: readString('AI_PROFILES_B64'),
  VISION_VERSION: readString('VISION_VERSION'),

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
  // Diagnostico local: loga prompt/resposta de cada lote do modelo.
  // NUNCA ligue em producao sem politica de retencao (contem dados da oferta).
  LLM_DEBUG: readBoolean('LLM_DEBUG', false),
  LLM_DEBUG_PROMPT: readBoolean('LLM_DEBUG_PROMPT', false),

  AI_MODEL_ID: readString('AI_MODEL_ID', 'default'),
  AI_MODEL_VERSION: readString('AI_MODEL_VERSION'),
  AI_MODELS_JSON: readString('AI_MODELS_JSON'),

  LLM_HTTP_BASE_URL: readString('LLM_HTTP_BASE_URL'),
  LLM_HTTP_API_KEY: readString('LLM_HTTP_API_KEY'),
  LLM_HTTP_MODEL: readString('LLM_HTTP_MODEL'),

  // Visao (F5): servico CLIP/SigLIP OPCIONAL para reordenar as imagens que o
  // extrator JA encontrou. `off` por padrao; nunca gera imagem/URL.
  VISION_PROVIDER: readString('VISION_PROVIDER', 'off'),
  VISION_HTTP_URL: readString('VISION_HTTP_URL'),
  VISION_HTTP_API_KEY: readString('VISION_HTTP_API_KEY'),
  VISION_TIMEOUT_MS: readInt('VISION_TIMEOUT_MS', 1500),
  VISION_MIN_SCORE: readFloat('VISION_MIN_SCORE', 0),

  // Replay/dataset (F6). Vazio = desligado. Contém dados de produto: opt-in.
  AI_REPLAY_PATH: readString('AI_REPLAY_PATH'),
  AI_REPLAY_MAX_BYTES: readInt('AI_REPLAY_MAX_BYTES', 50_000_000),
} as const

export function isTestEnvironment(): boolean {
  const value = env.ENVIRONMENT.toLowerCase()
  return value === 'test' || value === 'testing'
}

export function isDevelopmentEnvironment(): boolean {
  const value = env.ENVIRONMENT.trim().toLowerCase()
  return value === '' || value === 'dev' || value === 'develop' || value === 'development' || isTestEnvironment()
}

export function isProductionEnvironment(): boolean {
  return !isDevelopmentEnvironment()
}

export type AdjMode = 'off' | 'shadow' | 'assist' | 'on'

/**
 * Kill switch lido a CADA request (nao congelado no boot), para permitir
 * desligar o modelo sem restart em producao.
 *
 * Precedencia: AI_MODE (v2) > AI_ADJ_MODE (legado) > off.
 */
export function getMode(): AdjMode {
  const raw = process.env['AI_MODE']?.trim() || process.env['AI_ADJ_MODE']?.trim() || 'off'
  const value = raw.toLowerCase()
  if (value === 'shadow' || value === 'assist' || value === 'on') return value
  return 'off'
}

export function getAdjMode(): AdjMode {
  return getMode()
}
