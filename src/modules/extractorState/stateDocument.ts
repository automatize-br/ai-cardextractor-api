// ============================================================================
// Documento de estado publicado por CADA extractor em tb_aiExtractorInstances.
//
// A API central NÃO escreve mais esse estado: ela apenas consulta para escolher
// a instância menos ocupada. `reserved` continua sendo propriedade da API
// (reservas de slot) e nunca é sobrescrito aqui.
// ============================================================================

export interface CurrentInstanceState {
  saturated?: boolean | null
  bootId?: string | null
  lastSeq?: number | null
}

export interface StateInput {
  dns: string
  bootId: string
  seq: number
  version: string
  contractVersion: string
  coreVersion: string
  trimmerVersion: string
  platforms: string[]
  capacity: number
  use: number
  useRaw: number
  cpuMetricSupported: boolean
  reportedInflight: number
  queueDepth?: number
  status: 'online' | 'draining'
  now: Date
}

export interface StateFields {
  dns: string
  version: string
  contractVersion: string
  coreVersion: string
  trimmerVersion: string
  platforms: string[]
  capacity: number
  use: number
  useRaw: number
  cpuMetricSupported: boolean
  reportedInflight: number
  queueDepth: number
  status: 'online' | 'draining'
  saturated: boolean
  lastSeq: number
  bootId: string
  lastSeenAt: Date
}

/** Mesma normalização usada pela API (`normalizeDns`) para o `dns` casar 1:1. */
export function normalizeExtractorDns(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\.$/, '')
}

/** Histerese: satura em `busy`, só volta a aceitar abaixo de `resume`. */
export function nextSaturated(
  use: number,
  current: boolean | null | undefined,
  busyThreshold: number,
  resumeThreshold: number,
): boolean {
  if (use >= busyThreshold) return true
  if (use <= resumeThreshold) return false
  return current === true
}

export function buildStateFields(
  input: StateInput,
  current: CurrentInstanceState | null,
  thresholds: { busy: number; resume: number },
): StateFields {
  return {
    dns: input.dns,
    version: input.version,
    contractVersion: input.contractVersion,
    coreVersion: input.coreVersion,
    trimmerVersion: input.trimmerVersion,
    platforms: input.platforms,
    capacity: Math.max(1, input.capacity),
    use: Math.max(0, Math.min(100, input.use)),
    useRaw: Math.max(0, Math.min(100, input.useRaw)),
    cpuMetricSupported: input.cpuMetricSupported,
    reportedInflight: Math.max(0, input.reportedInflight),
    queueDepth: Math.max(0, input.queueDepth ?? 0),
    status: input.status,
    saturated: nextSaturated(input.use, current?.saturated, thresholds.busy, thresholds.resume),
    lastSeq: input.seq,
    bootId: input.bootId,
    lastSeenAt: input.now,
  }
}
