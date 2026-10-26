import type { AdjudicationStats } from '../../types/adjudication.ts'
import { dayKey } from '../../helpers/dayKey.ts'
import type { AdjudicationRecord, Persistence } from './types.ts'

interface Counters {
  total: number
  llm: number
  heuristic: number
  fallback: number
  modelCalls: number
  totalLatencyMs: number
  validationFailures: number
}

const MAX_RECORDS = 2000

function emptyCounters(): Counters {
  return { total: 0, llm: 0, heuristic: 0, fallback: 0, modelCalls: 0, totalLatencyMs: 0, validationFailures: 0 }
}

// Persistencia em memoria (dev/teste). Nao sobrevive a restart.
export class MemoryPersistence implements Persistence {
  readonly name = 'memory' as const
  private readonly records: AdjudicationRecord[] = []
  private readonly counters = new Map<string, Counters>()

  async save(record: AdjudicationRecord): Promise<void> {
    this.records.push(record)
    if (this.records.length > MAX_RECORDS) this.records.shift()

    const key = dayKey(record.createdAt)
    const counters = this.counters.get(key) ?? emptyCounters()
    counters.total += 1
    if (record.mode === 'fallback') counters.fallback += 1
    else if (record.mode === 'heuristic') counters.heuristic += 1
    else counters.llm += 1
    counters.modelCalls += record.modelCalls
    counters.totalLatencyMs += record.latencyMs
    counters.validationFailures += record.validationFailures
    this.counters.set(key, counters)
  }

  async stats(day: string): Promise<AdjudicationStats> {
    const counters = this.counters.get(day) ?? emptyCounters()
    return {
      day,
      total: counters.total,
      llm: counters.llm,
      heuristic: counters.heuristic,
      fallback: counters.fallback,
      modelCalls: counters.modelCalls,
      avgLatencyMs: counters.total === 0 ? 0 : Math.round(counters.totalLatencyMs / counters.total),
      validationFailures: counters.validationFailures,
    }
  }

  async close(): Promise<void> {
    this.records.length = 0
    this.counters.clear()
  }
}
