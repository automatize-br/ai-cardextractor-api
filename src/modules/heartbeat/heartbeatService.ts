import { createHmac, randomUUID } from 'node:crypto'
import { env } from '../../config/env.ts'
import { CONTRACT_VERSION, CORE_VERSION, SUPPORTED_PLATFORMS } from '../../config/version.ts'
import { sampleCpuUsage } from '../../helpers/cpuUsage.ts'
import { activeExtractions } from '../extraction/metrics.ts'

// ============================================================================
// Heartbeat do extractor para a API central. Envia CPU, in-flight, capacidade,
// versões e plataformas. HMAC por instância; bootId reinicia o seq.
// ============================================================================

const BOOT_ID = randomUUID()
let seq = 0
let timer: NodeJS.Timeout | null = null
let stopped = false

function signature(payload: {
  dns: string
  bootId: string
  seq: number
  ts: number
  use: number
  useRaw: number
  reportedInflight: number
  capacity: number
  contractVersion: string
  coreVersion: string
  platforms: string[]
}): string {
  const canonical = [
    payload.dns,
    payload.bootId,
    payload.seq,
    payload.ts,
    payload.use,
    payload.useRaw,
    payload.reportedInflight,
    payload.capacity,
    payload.contractVersion,
    payload.coreVersion,
    payload.platforms.join(','),
  ].join('|')
  return createHmac('sha256', env.EXTRACTOR_KEY).update(canonical).digest('hex')
}

function heartbeatUrl(): string {
  return `${env.EXTRACTOR_CONTROL_URL.replace(/\/+$/, '')}/api/v1/internal/ai-extractors/heartbeat`
}

export async function heartbeatOnce(status: 'online' | 'draining' = 'online'): Promise<boolean> {
  if (env.EXTRACTOR_DNS === '' || env.EXTRACTOR_KEY === '' || env.EXTRACTOR_CONTROL_URL === '') return false
  const cpu = sampleCpuUsage()
  const ts = Date.now()
  seq += 1
  const platforms = env.EXTRACTOR_PLATFORMS.length > 0 ? env.EXTRACTOR_PLATFORMS : [...SUPPORTED_PLATFORMS]
  const payload = {
    dns: env.EXTRACTOR_DNS,
    bootId: BOOT_ID,
    seq,
    ts,
    use: cpu.use,
    useRaw: cpu.useRaw,
    reportedInflight: activeExtractions(),
    capacity: env.EXTRACTOR_CAPACITY,
    contractVersion: CONTRACT_VERSION,
    coreVersion: CORE_VERSION,
    platforms,
  }
  try {
    const response = await fetch(heartbeatUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-extractor-dns': payload.dns,
        'x-extractor-boot-id': payload.bootId,
        'x-extractor-seq': String(payload.seq),
        'x-extractor-ts': String(payload.ts),
        'x-extractor-signature': signature(payload),
        ...(env.AI_INTERNAL_KEY !== '' ? { 'x-internal-key': env.AI_INTERNAL_KEY } : {}),
      },
      body: JSON.stringify({
        ...payload,
        version: env.EXTRACTOR_VERSION,
        cardTrimmerVersion: env.EXTRACTOR_CARD_TRIMMER_VERSION,
        cpuMetricSupported: cpu.supported,
        queueDepth: 0,
        eventLoopLagMs: 0,
        p95LatencyMs: 0,
        status,
        measuredAt: new Date(ts).toISOString(),
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      console.warn(`[heartbeat] rejected status=${response.status} dns=${payload.dns}`)
      return false
    }
    return true
  } catch (error) {
    console.warn('[heartbeat] failed:', error instanceof Error ? error.message : error)
    return false
  }
}

export function startHeartbeat(): void {
  if (timer || env.EXTRACTOR_CONTROL_URL === '' || env.EXTRACTOR_DNS === '' || env.EXTRACTOR_KEY === '') return
  stopped = false
  void heartbeatOnce('online')
  timer = setInterval(() => {
    if (!stopped) void heartbeatOnce('online')
  }, Math.max(5000, env.EXTRACTOR_HEARTBEAT_INTERVAL_MS))
  timer.unref()
}

export async function stopHeartbeat(): Promise<void> {
  stopped = true
  if (timer) clearInterval(timer)
  timer = null
  await heartbeatOnce('draining')
}
