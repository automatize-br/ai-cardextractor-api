import { randomUUID } from 'node:crypto'
import { env } from '../../config/env.ts'
import { CONTRACT_VERSION, CORE_VERSION, SUPPORTED_PLATFORMS } from '../../config/version.ts'
import { sampleCpuUsage } from '../../helpers/cpuUsage.ts'
import mongoose from '../../providers/mongoose.ts'
import { activeExtractions } from '../extraction/metrics.ts'
import { buildStateFields, normalizeExtractorDns } from './stateDocument.ts'
import type { CurrentInstanceState } from './stateDocument.ts'

// ============================================================================
// Estado do pool escrito PELO PRÓPRIO EXTRACTOR.
//
// A cada EXTRACTOR_STATE_INTERVAL_MS (default 180s) esta instância faz um
// upsert do seu documento em tb_aiExtractorInstances: CPU, in-flight,
// capacidade, plataformas, versões e `lastSeenAt`. A API central só LÊ essa
// coleção para escolher a instância menos ocupada — nenhum heartbeat HTTP
// entra no caminho crítico dela.
//
// `reserved` NÃO é escrito aqui: é propriedade da API (reserva de slot).
// ============================================================================

export const EXTRACTOR_INSTANCES_COLLECTION = 'tb_aiextractorinstances'
export const MIN_STATE_INTERVAL_MS = 15_000

const BOOT_ID = randomUUID()
let seq = 0
let timer: NodeJS.Timeout | null = null
let stopped = false
let warnedNoMongo = false
let warnedNoDns = false
let lastPublishedAt: Date | null = null

export function stateBootId(): string {
  return BOOT_ID
}

export function lastStatePublishedAt(): Date | null {
  return lastPublishedAt
}

function instancesCollection() {
  if (mongoose.connection.readyState !== 1) return null
  return mongoose.connection.db?.collection(EXTRACTOR_INSTANCES_COLLECTION) ?? null
}

/**
 * Publica o estado atual. Best-effort: falha de Mongo nunca derruba a extração.
 * Retorna `true` quando o upsert foi concluído.
 */
export async function publishStateOnce(status: 'online' | 'draining' = 'online'): Promise<boolean> {
  if (env.EXTRACTOR_STATE_MODE !== 'mongo') return false
  const dns = normalizeExtractorDns(env.EXTRACTOR_DNS)
  if (dns === '') {
    if (!warnedNoDns) {
      warnedNoDns = true
      console.warn('[state] EXTRACTOR_STATE_MODE=mongo sem EXTRACTOR_DNS — estado não será publicado.')
    }
    return false
  }
  const collection = instancesCollection()
  if (!collection) {
    if (!warnedNoMongo) {
      warnedNoMongo = true
      console.warn('[state] Mongo indisponível — estado do pool não será publicado até reconectar.')
    }
    return false
  }
  warnedNoMongo = false

  // sampleCpuUsage mede o delta desde a chamada anterior: manter a série
  // contínua mesmo quando um publish falha.
  const cpu = sampleCpuUsage()
  seq += 1
  const now = new Date()
  const platforms = env.EXTRACTOR_PLATFORMS.length > 0 ? env.EXTRACTOR_PLATFORMS : [...SUPPORTED_PLATFORMS]

  try {
    const current = await collection.findOne(
      { dns },
      { projection: { saturated: 1, bootId: 1, lastSeq: 1 } },
    )
    const fields = buildStateFields(
      {
        dns,
        bootId: BOOT_ID,
        seq,
        version: env.EXTRACTOR_VERSION.trim() === '' ? 'dev' : env.EXTRACTOR_VERSION,
        contractVersion: CONTRACT_VERSION,
        coreVersion: CORE_VERSION,
        trimmerVersion: env.EXTRACTOR_CARD_TRIMMER_VERSION,
        platforms,
        capacity: env.EXTRACTOR_CAPACITY,
        use: cpu.use,
        useRaw: cpu.useRaw,
        cpuMetricSupported: cpu.supported,
        reportedInflight: activeExtractions(),
        status,
        now,
      },
      current as CurrentInstanceState | null,
      { busy: env.EXTRACTOR_SATURATION_THRESHOLD, resume: env.EXTRACTOR_RESUME_THRESHOLD },
    )
    await collection.updateOne(
      { dns },
      { $set: fields, $setOnInsert: { reserved: 0 } },
      { upsert: true },
    )
    lastPublishedAt = now
    return true
  } catch (error) {
    console.warn('[state] falha ao publicar estado:', error instanceof Error ? error.message : error)
    return false
  }
}

export function startExtractorState(): void {
  if (timer) return
  if (env.EXTRACTOR_STATE_MODE !== 'mongo') return
  stopped = false
  void publishStateOnce('online')
  const interval = Math.max(MIN_STATE_INTERVAL_MS, env.EXTRACTOR_STATE_INTERVAL_MS)
  timer = setInterval(() => {
    if (!stopped) void publishStateOnce('online')
  }, interval)
  timer.unref()
  console.log(`[state] publicando em ${EXTRACTOR_INSTANCES_COLLECTION} a cada ${Math.round(interval / 1000)}s (dns=${env.EXTRACTOR_DNS || '?'})`)
}

/** Publica `draining` (a API deixa de escolher esta instância) e para o timer. */
export async function stopExtractorState(): Promise<void> {
  stopped = true
  if (timer) clearInterval(timer)
  timer = null
  await publishStateOnce('draining')
}

export function resetExtractorStateForTests(): void {
  if (timer) clearInterval(timer)
  timer = null
  stopped = false
  warnedNoMongo = false
  warnedNoDns = false
  lastPublishedAt = null
  seq = 0
}
