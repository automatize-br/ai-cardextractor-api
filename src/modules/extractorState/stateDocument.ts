// ============================================================================
// Documento de estado publicado por CADA extractor em tb_aiExtractorInstances.
//
// A API central NÃO escreve mais esse estado: ela apenas consulta para escolher
// a instância menos ocupada. `reserved` continua sendo propriedade da API
// (reservas de slot) e nunca é sobrescrito aqui.
//
// A partir da Etapa B (PLAN2):
// - `workerId` é a identidade estável; `dns`/`host` são metadados;
// - o worker NÃO escreve `status`/`desiredStatus` (admin/reaper são donos);
// - `observedStatus` é derivado pelo reaper no central (offline/online);
// - `capabilities` é o que o worker consegue executar hoje (sem browser, sem
//   plataformas JS-only);
// - `offersContractVersion` gateia a elegibilidade junto do `coreMajor`.
// ============================================================================

export interface CurrentInstanceState {
  saturated?: boolean | null
  bootId?: string | null
  lastSeq?: number | null
  observedStatus?: string | null
}

export interface StateInput {
  workerId: string
  dns: string
  host: string
  bootId: string
  seq: number
  version: string
  contractVersion: string
  offersContractVersion: string
  coreVersion: string
  coreMajor: number
  trimmerVersion: string
  platforms: string[]
  capabilities: string[]
  capacity: number
  use: number
  useRaw: number
  cpuMetricSupported: boolean
  reportedInflight: number
  activeJobs: number
  queueDepth?: number
  memoryAvailableMb: number
  /** `online` no snapshot; `draining` só no shutdown gracioso (dica observada). */
  observedStatus: 'online' | 'draining'
  now: Date
}

export interface StateFields {
  workerId: string
  dns: string
  host: string
  version: string
  contractVersion: string
  offersContractVersion: string
  coreVersion: string
  coreMajor: number
  trimmerVersion: string
  platforms: string[]
  capabilities: string[]
  capacity: number
  use: number
  useRaw: number
  cpuMetricSupported: boolean
  reportedInflight: number
  activeJobs: number
  queueDepth: number
  memoryAvailableMb: number
  observedStatus: 'online' | 'draining'
  saturated: boolean
  lastSeq: number
  bootId: string
  lastSeenAt: Date
  lastHeartbeatAt: Date
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
    workerId: input.workerId,
    dns: input.dns,
    host: input.host,
    version: input.version,
    contractVersion: input.contractVersion,
    offersContractVersion: input.offersContractVersion,
    coreVersion: input.coreVersion,
    coreMajor: input.coreMajor,
    trimmerVersion: input.trimmerVersion,
    platforms: input.platforms,
    capabilities: input.capabilities,
    capacity: Math.max(1, input.capacity),
    use: Math.max(0, Math.min(100, input.use)),
    useRaw: Math.max(0, Math.min(100, input.useRaw)),
    cpuMetricSupported: input.cpuMetricSupported,
    reportedInflight: Math.max(0, input.reportedInflight),
    activeJobs: Math.max(0, input.activeJobs),
    queueDepth: Math.max(0, input.queueDepth ?? 0),
    memoryAvailableMb: Math.max(0, input.memoryAvailableMb),
    observedStatus: input.observedStatus,
    saturated: nextSaturated(input.use, current?.saturated, thresholds.busy, thresholds.resume),
    lastSeq: input.seq,
    bootId: input.bootId,
    lastSeenAt: input.now,
    lastHeartbeatAt: input.now,
  }
}
