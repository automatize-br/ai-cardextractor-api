import { readFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'

// ============================================================================
// Amostrador de CPU da instância.
//
// Ordem: cgroup v2/v1 (CPU REAL do container/VPS — não a do host inteiro),
// /proc/stat (VPS sem container) e, por último, loadavg (dev/Windows).
// O valor é uma fração da capacidade (0–100), com suavização de 50%.
// ============================================================================

interface CgroupSample {
  usageUs: number
  at: number
}

interface CpuSample {
  idle: number
  total: number
}

let previousCgroup: CgroupSample | null = null
let previousProc: CpuSample | null = null
let previousUse = 0

function readCgroupCores(): number {
  // cgroup v2
  try {
    const parts = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/)
    const quota = Number(parts[0])
    const period = Number(parts[1])
    if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) {
      return Math.max(1, quota / period)
    }
  } catch {
    // sem quota (host) → segue para o número de CPUs
  }
  // cgroup v1
  try {
    const quota = Number(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim())
    const period = Number(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim())
    if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) {
      return Math.max(1, quota / period)
    }
  } catch {
    // sem quota v1
  }
  return Math.max(1, cpus().length)
}

function readCgroupUsage(): { usageUs: number; cores: number } | null {
  // cgroup v2
  try {
    const match = /^usage_usec\s+(\d+)/m.exec(readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8'))
    if (match?.[1]) return { usageUs: Number(match[1]), cores: readCgroupCores() }
  } catch {
    // tenta v1
  }
  // cgroup v1
  try {
    const usageNs = Number(readFileSync('/sys/fs/cgroup/cpuacct/cpuacct.usage', 'utf8').trim())
    if (Number.isFinite(usageNs) && usageNs >= 0) {
      return { usageUs: usageNs / 1000, cores: readCgroupCores() }
    }
  } catch {
    // sem cgroup
  }
  return null
}

function readProcStat(): CpuSample | null {
  try {
    const line = readFileSync('/proc/stat', 'utf8').split('\n').find((item) => item.startsWith('cpu '))
    if (!line) return null
    const parts = line.trim().split(/\s+/).slice(1).map(Number)
    if (parts.length < 4 || parts.some((value) => !Number.isFinite(value))) return null
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0)
    const total = parts.reduce((sum, value) => sum + value, 0)
    return { idle, total }
  } catch {
    return null
  }
}

function smooth(raw: number): number {
  previousUse = previousUse === 0 ? raw : previousUse * 0.5 + raw * 0.5
  return Math.round(previousUse * 10) / 10
}

export interface CpuUsage {
  use: number
  useRaw: number
  supported: boolean
  cpuCount: number
}

export function sampleCpuUsage(): CpuUsage {
  const cgroup = readCgroupUsage()
  if (cgroup) {
    const now = Date.now()
    if (!previousCgroup) {
      previousCgroup = { usageUs: cgroup.usageUs, at: now }
      return { use: 0, useRaw: 0, supported: true, cpuCount: Math.round(cgroup.cores * 10) / 10 }
    }
    const deltaUsageUs = Math.max(0, cgroup.usageUs - previousCgroup.usageUs)
    const deltaWallUs = Math.max(1, (now - previousCgroup.at) * 1000)
    previousCgroup = { usageUs: cgroup.usageUs, at: now }
    const raw = Math.min(100, Math.max(0, (deltaUsageUs / (deltaWallUs * cgroup.cores)) * 100))
    return {
      use: smooth(raw),
      useRaw: Math.round(raw * 10) / 10,
      supported: true,
      cpuCount: Math.round(cgroup.cores * 10) / 10,
    }
  }

  const cpuCount = Math.max(1, cpus().length)
  const sample = readProcStat()
  if (sample) {
    if (!previousProc) {
      previousProc = sample
      return { use: 0, useRaw: 0, supported: true, cpuCount }
    }
    const idleDelta = Math.max(0, sample.idle - previousProc.idle)
    const totalDelta = Math.max(1, sample.total - previousProc.total)
    previousProc = sample
    const raw = Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100))
    return { use: smooth(raw), useRaw: Math.round(raw * 10) / 10, supported: true, cpuCount }
  }

  const load = loadavg()[0] ?? 0
  if (load <= 0) {
    return { use: 0, useRaw: 0, supported: false, cpuCount }
  }
  const raw = Math.min(100, Math.max(0, (load / cpuCount) * 100))
  return { use: smooth(raw), useRaw: Math.round(raw * 10) / 10, supported: true, cpuCount }
}

export function resetCpuUsageForTests(): void {
  previousCgroup = null
  previousProc = null
  previousUse = 0
}
