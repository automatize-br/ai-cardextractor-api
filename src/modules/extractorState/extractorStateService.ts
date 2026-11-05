import { randomUUID } from 'node:crypto'
import { freemem } from 'node:os'
import { env } from '../../config/env.ts'
import {
  CONTRACT_VERSION,
  CORE_MAJOR,
  CORE_VERSION,
  OFFERS_CONTRACT_VERSION,
  SUPPORTED_PLATFORMS,
  workerCapabilities,
} from '../../config/version.ts'
import { sampleCpuUsage } from '../../helpers/cpuUsage.ts'
import mongoose from '../../providers/mongoose.ts'
import { activeExtractions } from '../extraction/metrics.ts'
import { buildStateFields, normalizeExtractorDns } from './stateDocument.ts'
import type { CurrentInstanceState } from './stateDocument.ts'
import { loadWorkerId } from './workerIdentity.ts'

// ============================================================================
// Estado do pool escrito PELO PRÓPRIO EXTRACTOR.
//
// - Snapshot de métricas a cada EXTRACTOR_STATE_INTERVAL_MS (default 180s).
// - Heartbeat de liveness a cada EXTRACTOR_STATE_HEARTBEAT_MS (default 20s):
//   update PARCIAL de lastHeartbeatAt/in-flight, sem reescrever o documento.
//
// A API central só LÊ essa coleção para escolher a instância menos ocupada.
// `reserved` NÃO é escrito aqui (propriedade da API). O worker também NÃO
// escreve `desiredStatus`/`status`: admin/reaper são donos do estado desejado.
// ============================================================================

export const EXTRACTOR_INSTANCES_COLLECTION = 'tb_aiextractorinstances'
export const MIN_STATE_INTERVAL_MS = 15_000
export const MIN_HEARTBEAT_INTERVAL_MS = 5_000

const BOOT_ID = randomUUID()
let seq = 0
let timer: NodeJS.Timeout | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
let stopped = false
let warnedNoMongo = false
let warnedNoDns = false
let lastPublishedAt: Date | null = null
let workerId = ''

export function stateBootId(): string {
  return BOOT_ID
}

export function lastStatePublishedAt(): Date | null {
  return lastPublishedAt
}

export function currentWorkerId(): string {
  return workerId
}

export function extractorCapabilities(): string[] {
  const configured = env.EXTRACTOR_PLATFORMS.length > 0 ? env.EXTRACTOR_PLATFORMS : [...SUPPORTED_PLATFORMS]
  return workerCapabilities(configured, env.WORKER_BROWSER_ENABLED)
}

function instancesCollection() {
  if (mongoose.connection.readyState !== 1) return null
  return mongoose.connection.db?.collection(EXTRACTOR_INSTANCES_COLLECTION) ?? null
}

function requireTarget(): { dns: string; collection: NonNullable<ReturnType<typeof instancesCollection>> } | null {
  if (env.EXTRACTOR_STATE_MODE !== 'mongo') return null
  const dns = normalizeExtractorDns(env.EXTRACTOR_DNS)
  if (dns === '') {
    if (!warnedNoDns) {
      warnedNoDns = true
      console.warn('[state] EXTRACTOR_STATE_MODE=mongo sem EXTRACTOR_DNS — estado não será publicado.')
    }
    return null
  }
  const collection = instancesCollection()
  if (!collection) {
    if (!warnedNoMongo) {
      warnedNoMongo = true
      console.warn('[state] Mongo indisponível — estado do pool não será publicado até reconectar.')
    }
    return null
  }
  warnedNoMongo = false
  return { dns, collection }
}

/**
 * Publica o snapshot completo. Best-effort: falha de Mongo nunca derruba a
 * extração. Retorna `true` quando o upsert foi concluído.
 */
export async function publishStateOnce(
  observedStatus: 'online' | 'draining' = 'online',
): Promise<boolean> {
  const target = requireTarget()
  if (!target) return false
  const { dns, collection } = target
  if (workerId === '') workerId = loadWorkerId()

  // sampleCpuUsage mede o delta desde a chamada anterior: manter a série
  // contínua mesmo quando um publish falha.
  const cpu = sampleCpuUsage()
  seq += 1
  const now = new Date()
  const inflight = activeExtractions()

  try {
    const current = await collection.findOne(
      { dns },
      { projection: { saturated: 1, bootId: 1, lastSeq: 1, observedStatus: 1 } },
    )
    const fields = buildStateFields(
      {
        workerId,
        dns,
        host: env.EXTRACTOR_HOST.trim() || dns,
        bootId: BOOT_ID,
        seq,
        version: env.EXTRACTOR_VERSION.trim() === '' ? 'dev' : env.EXTRACTOR_VERSION,
        contractVersion: CONTRACT_VERSION,
        offersContractVersion: OFFERS_CONTRACT_VERSION,
        coreVersion: CORE_VERSION,
        coreMajor: CORE_MAJOR,
        trimmerVersion: env.EXTRACTOR_CARD_TRIMMER_VERSION,
        platforms: env.EXTRACTOR_PLATFORMS.length > 0 ? env.EXTRACTOR_PLATFORMS : [...SUPPORTED_PLATFORMS],
        capabilities: extractorCapabilities(),
        capacity: Math.min(env.EXTRACTOR_CAPACITY_MAX, Math.max(1, env.EXTRACTOR_CAPACITY)),
        use: cpu.use,
        useRaw: cpu.useRaw,
        cpuMetricSupported: cpu.supported,
        reportedInflight: inflight,
        activeJobs: inflight,
        memoryAvailableMb: Math.round(freemem() / 1024 / 1024),
        observedStatus,
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

/**
 * Heartbeat parcial: mantém a instância "viva" sem reescrever métricas.
 * Não toca `desiredStatus`/`observedStatus` — quem decide é o reaper do central.
 */
export async function publishHeartbeatOnce(): Promise<boolean> {
  const target = requireTarget()
  if (!target) return false
  try {
    const inflight = activeExtractions()
    await target.collection.updateOne(
      { dns: target.dns },
      {
        $set: {
          lastHeartbeatAt: new Date(),
          lastSeenAt: new Date(),
          activeJobs: inflight,
          reportedInflight: inflight,
        },
      },
    )
    return true
  } catch (error) {
    console.warn('[heartbeat] falha ao publicar liveness:', error instanceof Error ? error.message : error)
    return false
  }
}

export function startExtractorState(): void {
  if (timer) return
  if (env.EXTRACTOR_STATE_MODE !== 'mongo') return
  workerId = loadWorkerId()
  stopped = false
  void publishStateOnce('online')

  const interval = Math.max(MIN_STATE_INTERVAL_MS, env.EXTRACTOR_STATE_INTERVAL_MS)
  timer = setInterval(() => {
    if (!stopped) void publishStateOnce('online')
  }, interval)
  timer.unref()

  const heartbeatMs = Math.max(MIN_HEARTBEAT_INTERVAL_MS, env.EXTRACTOR_STATE_HEARTBEAT_MS)
  heartbeatTimer = setInterval(() => {
    if (!stopped) void publishHeartbeatOnce()
  }, heartbeatMs)
  heartbeatTimer.unref()

  console.log(
    `[state] publicando em ${EXTRACTOR_INSTANCES_COLLECTION} a cada ${Math.round(interval / 1000)}s ` +
      `(heartbeat ${Math.round(heartbeatMs / 1000)}s, workerId=${workerId}, ` +
      `capabilities=${extractorCapabilities().join(',') || '-'})`,
  )
}

/** Publica `draining` (dica observada) e para os timers. */
export async function stopExtractorState(): Promise<void> {
  stopped = true
  if (timer) clearInterval(timer)
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  timer = null
  heartbeatTimer = null
  await publishStateOnce('draining')
}

export function resetExtractorStateForTests(): void {
  if (timer) clearInterval(timer)
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  timer = null
  heartbeatTimer = null
  stopped = false
  warnedNoMongo = false
  warnedNoDns = false
  lastPublishedAt = null
  workerId = ''
}
