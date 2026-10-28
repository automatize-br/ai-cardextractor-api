import { env, aiConfigSource } from '../../config/env.ts'
import mongoose from '../../providers/mongoose.ts'
import { applyAiConfig } from './apply.ts'
import { decryptSecretWithKey } from './decrypt.ts'
import { getRuntimeAiConfig } from './runtimeConfig.ts'
import type { RuntimeAiConfig } from './runtimeConfig.ts'

// ============================================================================
// Config de IA lida DIRETO de tb_aiextractorconfigs.
//
// Substitui o heartbeat/bootstrap HTTP: o painel admin grava no Mongo, cada
// extractor faz polling e aplica em memória (sem reiniciar e sem .env). A
// chave é decifrada localmente com CREDENTIALS_ENC_KEY (mesma da API).
// ============================================================================

export const AI_CONFIG_COLLECTION = 'tb_aiextractorconfigs'
export const MIN_CONFIG_POLL_MS = 5_000

const MODES = ['off', 'shadow', 'assist', 'on'] as const
const STRUCTURED = ['json_schema', 'json_object', 'none'] as const

let timer: NodeJS.Timeout | null = null
let stopped = false
let lastAppliedVersion: number | null = null
let warnedNoMongo = false

function asString(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

/**
 * Converte o documento do Mongo no payload aceito por `applyAiConfig`.
 * Lança quando a chave existe mas não pode ser decifrada (fail-closed: a
 * config anterior continua valendo).
 */
export function buildRuntimeConfig(
  doc: Record<string, unknown>,
  decrypt: (payload: string) => string,
): RuntimeAiConfig {
  const provider = doc['provider'] === 'fake' ? 'fake' : 'openai-compatible'
  const encrypted = typeof doc['encryptedApiKey'] === 'string' ? doc['encryptedApiKey'] : ''
  const apiKey = encrypted === '' ? null : decrypt(encrypted)
  const mode = MODES.includes(doc['mode'] as (typeof MODES)[number])
    ? (doc['mode'] as RuntimeAiConfig['mode'])
    : 'off'
  const structured = STRUCTURED.includes(doc['structuredOutput'] as (typeof STRUCTURED)[number])
    ? (doc['structuredOutput'] as RuntimeAiConfig['structuredOutput'])
    : 'json_schema'
  return {
    contractVersion: '1',
    configId: asString(doc['configId'], 64) || 'default',
    version: Math.max(0, Math.trunc(Number(doc['version']) || 0)),
    enabled: doc['enabled'] === true,
    mode,
    provider,
    baseUrl: asString(doc['baseUrl']),
    model: asString(doc['model'], 160),
    apiKey: apiKey === '' ? null : apiKey,
    temperature: asNumber(doc['temperature'], 0, 0, 2),
    maxTokens: Math.trunc(asNumber(doc['maxTokens'], 800, 64, 32768)),
    timeoutMs: Math.trunc(asNumber(doc['timeoutMs'], 30_000, 1000, 120_000)),
    structuredOutput: structured,
  }
}

function collection() {
  if (mongoose.connection.readyState !== 1) return null
  return mongoose.connection.db?.collection(AI_CONFIG_COLLECTION) ?? null
}

/** Lê a config no Mongo e aplica quando a versão mudou. */
export async function pollAiConfigOnce(force = false): Promise<{ applied: boolean; version: number | null }> {
  if (aiConfigSource() !== 'mongo') return { applied: false, version: null }
  const coll = collection()
  if (!coll) {
    if (!warnedNoMongo) {
      warnedNoMongo = true
      console.warn('[ai-config] Mongo indisponível — mantendo a config em memória.')
    }
    return { applied: false, version: null }
  }
  warnedNoMongo = false
  try {
    const doc = (await coll.findOne({ configId: 'default' })) as Record<string, unknown> | null
    if (!doc) return { applied: false, version: null }
    const version = Math.max(0, Math.trunc(Number(doc['version']) || 0))
    const current = getRuntimeAiConfig()
    if (!force && lastAppliedVersion === version && current?.version === version) {
      return { applied: false, version }
    }
    if (env.CREDENTIALS_ENC_KEY === '' && typeof doc['encryptedApiKey'] === 'string' && doc['encryptedApiKey'] !== '') {
      console.warn('[ai-config] CREDENTIALS_ENC_KEY ausente — não é possível decifrar a API key do painel.')
      return { applied: false, version: null }
    }
    const config = buildRuntimeConfig(doc, (payload) => decryptSecretWithKey(payload, env.CREDENTIALS_ENC_KEY))
    const result = applyAiConfig(config)
    if (result.applied) {
      lastAppliedVersion = version
      console.log(`[ai-config] aplicada versão ${version} (${config.provider}/${config.model || 'sem-modelo'}, enabled=${config.enabled}, mode=${config.mode})`)
    }
    return result
  } catch (error) {
    console.warn('[ai-config] falha ao ler/aplicar config:', error instanceof Error ? error.message : error)
    return { applied: false, version: null }
  }
}

export function startAiConfigPoll(): void {
  if (timer) return
  if (aiConfigSource() !== 'mongo') return
  stopped = false
  void pollAiConfigOnce(true)
  const interval = Math.max(MIN_CONFIG_POLL_MS, env.AI_CONFIG_POLL_MS)
  timer = setInterval(() => {
    if (!stopped) void pollAiConfigOnce()
  }, interval)
  timer.unref()
  console.log(`[ai-config] lendo ${AI_CONFIG_COLLECTION} a cada ${Math.round(interval / 1000)}s`)
}

export function stopAiConfigPoll(): void {
  stopped = true
  if (timer) clearInterval(timer)
  timer = null
}

export function resetAiConfigPollForTests(): void {
  stopAiConfigPoll()
  stopped = false
  warnedNoMongo = false
  lastAppliedVersion = null
}
