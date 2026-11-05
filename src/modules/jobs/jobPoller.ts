import { env } from '../../config/env.ts'
import { activeExtractions, beginExtraction, endExtraction } from '../extraction/metrics.ts'
import RemoteExtractionService, { type RemoteExtractionResult } from '../remoteExtraction/remoteExtractionService.ts'
import { loadWorkerId } from '../extractorState/workerIdentity.ts'

// ============================================================================
// Worker pull do bulk (PLAN2 §16.5).
//
// O worker NÃO escreve no Mongo: claim/renovação/resultado passam pelo control
// plane da API (autenticado). O pipeline é o MESMO do contrato v2 síncrono
// (fetch -> challenge -> trim -> extração -> revalidação).
//
// Desligado por default (`EXTRACTOR_JOBS_ENABLED=false`): o caminho síncrono
// continua funcionando sem fila.
// ============================================================================

interface ClaimedJob {
  jobId: string
  claim: number
  leaseToken: string
  marketplace: string
  categories: string[]
  urls: string[]
  query: string
  profile: string
  deadlineAt: string
  participants: string[]
  ownerId: string
}

let timer: NodeJS.Timeout | null = null
let stopped = false
let ticking = false
let lastError: string | null = null

function controlBase(): string {
  return env.EXTRACTOR_CONTROL_URL.replace(/\/+$/, '')
}

function headers(): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(env.AI_INTERNAL_KEY !== '' ? { 'x-internal-key': env.AI_INTERNAL_KEY } : {}),
  }
}

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${controlBase()}/api/v1/internal/ai-extractors${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  if (!response.ok) {
    const message =
      (parsed as { message?: string } | null)?.message ?? `HTTP ${response.status}`
    throw new Error(`[jobs] ${path}: ${message}`)
  }
  return ((parsed as { data?: T } | null)?.data ?? parsed) as T
}

async function claimJobs(workerId: string): Promise<ClaimedJob[]> {
  const data = await call<{ jobs?: ClaimedJob[] }>('/jobs/claim', {
    workerId,
    limit: Math.max(1, env.EXTRACTOR_JOBS_BATCH),
  })
  return data?.jobs ?? []
}

async function renew(job: ClaimedJob, workerId: string): Promise<void> {
  await call(`/jobs/${job.jobId}/renew`, {
    workerId,
    leaseToken: job.leaseToken,
    claim: job.claim,
  })
}

async function publishResult(job: ClaimedJob, workerId: string, result: RemoteExtractionResult): Promise<void> {
  await call(`/jobs/${job.jobId}/result`, {
    workerId,
    leaseToken: job.leaseToken,
    claim: job.claim,
    offers: result.offers,
    discarded: result.discarded,
    quality: result.quality,
    fetchedAt: new Date().toISOString(),
  })
}

async function reportFailure(
  job: ClaimedJob,
  workerId: string,
  errorCode: string,
  errorMessage: string,
  retryable: boolean,
): Promise<void> {
  await call(`/jobs/${job.jobId}/fail`, {
    workerId,
    leaseToken: job.leaseToken,
    claim: job.claim,
    errorCode,
    errorMessage: errorMessage.slice(0, 400),
    retryable,
  })
}

async function runJob(job: ClaimedJob, workerId: string): Promise<void> {
  const deadlineAt = Date.parse(job.deadlineAt)
  const budget = Number.isFinite(deadlineAt) ? Math.max(1_000, deadlineAt - Date.now()) : env.EXTRACTOR_SCRAPE_TIMEOUT_MS
  const renewTimer = setInterval(() => {
    void renew(job, workerId).catch((error) => {
      lastError = error instanceof Error ? error.message : String(error)
      console.warn('[jobs] renovação de lease falhou:', lastError)
    })
  }, Math.max(5_000, env.EXTRACTOR_JOBS_RENEW_MS))
  renewTimer.unref()

  try {
    const result = await RemoteExtractionService.extract({
      requestId: job.jobId,
      marketplace: job.marketplace,
      urls: job.urls,
      query: job.query,
      profile: job.profile || env.AI_DEFAULT_PROFILE,
      mode: 'off',
      maxScanned: 200,
      maxCards: 200,
      maxLlmCards: 0,
      deadlineAt: Date.now() + Math.min(budget, env.EXTRACTOR_SCRAPE_TIMEOUT_MS),
    })

    console.log(
      `[jobs] done jobId=${job.jobId} marketplace=${job.marketplace} quality=${result.quality} ` +
        `offers=${result.offers.length} sources=${result.sources.length} ms=${result.durationMs}`,
    )

    if (result.quality === 'blocked' || result.quality === 'unavailable') {
      await reportFailure(
        job,
        workerId,
        result.quality === 'blocked' ? 'SCRAPE_BLOCKED' : 'SCRAPE_UNAVAILABLE',
        result.reason ?? result.quality,
        true,
      )
      return
    }

    await publishResult(job, workerId, result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    lastError = message
    console.warn(`[jobs] falha jobId=${job.jobId}:`, message)
    await reportFailure(job, workerId, 'EXTRACTION_FAILED', message, true).catch((reportError) => {
      console.warn('[jobs] falha ao reportar erro:', reportError instanceof Error ? reportError.message : reportError)
    })
  } finally {
    clearInterval(renewTimer)
  }
}

async function tick(): Promise<void> {
  if (stopped || ticking || !env.EXTRACTOR_JOBS_ENABLED) return
  if (activeExtractions() >= env.EXTRACTOR_CAPACITY) return
  ticking = true
  try {
    const workerId = loadWorkerId()
    const jobs = await claimJobs(workerId)
    for (const job of jobs) {
      if (stopped) break
      if (activeExtractions() >= env.EXTRACTOR_CAPACITY) break
      beginExtraction()
      try {
        await runJob(job, workerId)
      } finally {
        endExtraction()
      }
    }
    lastError = null
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    // Control plane indisponível: não derruba o worker, tenta no próximo tick.
  } finally {
    ticking = false
  }
}

export function jobsLastError(): string | null {
  return lastError
}

export function startJobPoller(): void {
  if (timer || !env.EXTRACTOR_JOBS_ENABLED) return
  if (env.EXTRACTOR_CONTROL_URL.trim() === '') {
    console.warn('[jobs] EXTRACTOR_JOBS_ENABLED=true sem EXTRACTOR_CONTROL_URL — poller desligado.')
    return
  }
  stopped = false
  const interval = Math.max(1_000, env.EXTRACTOR_JOBS_POLL_MS)
  void tick()
  timer = setInterval(() => {
    void tick()
  }, interval)
  timer.unref()
  console.log(
    `[jobs] poller ativo (poll ${interval}ms, batch ${env.EXTRACTOR_JOBS_BATCH}, ` +
      `workerId=${loadWorkerId()})`,
  )
}

export function stopJobPoller(): void {
  stopped = true
  if (timer) clearInterval(timer)
  timer = null
}

export function resetJobPollerForTests(): void {
  stopJobPoller()
  stopped = false
  ticking = false
  lastError = null
}
