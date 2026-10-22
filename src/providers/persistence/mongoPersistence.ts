import tb_aiAdjudications from '../../domain/schemas/tb_aiAdjudications.ts'
import tb_aiUsage from '../../domain/schemas/tb_aiUsage.ts'
import { dayKey } from '../../helpers/dayKey.ts'
import type { AdjudicationStats } from '../../types/adjudication.ts'
import type { AdjudicationRecord, Persistence } from './types.ts'

// Persistencia em Mongo (AI_PERSISTENCE=mongo). Metricas agregadas por dia.
export class MongoPersistence implements Persistence {
  readonly name = 'mongo' as const

  private async incrementUsage(record: AdjudicationRecord): Promise<void> {
    await tb_aiUsage.updateOne(
      { day: dayKey(record.createdAt) },
      {
        $inc: {
          total: 1,
          llm: record.mode === 'llm' || record.mode === 'fake' ? 1 : 0,
          heuristic: record.mode === 'heuristic' ? 1 : 0,
          fallback: record.mode === 'fallback' ? 1 : 0,
          modelCalls: record.modelCalls,
          totalLatencyMs: record.latencyMs,
          validationFailures: record.validationFailures,
        },
      },
      { upsert: true },
    )
  }

  async save(record: AdjudicationRecord): Promise<void> {
    await tb_aiAdjudications.create(record)
    // O primeiro upsert do dia pode correr com outra requisicao e bater no
    // indice unico de `day` (E11000). O retry converge para o mesmo documento.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.incrementUsage(record)
        return
      } catch (error) {
        const code = (error as { code?: number }).code
        if (code !== 11000 || attempt >= 2) throw error
      }
    }
  }

  async stats(day: string): Promise<AdjudicationStats> {
    const doc = await tb_aiUsage.findOne({ day }).lean()
    if (!doc) {
      return {
        day,
        total: 0,
        llm: 0,
        heuristic: 0,
        fallback: 0,
        modelCalls: 0,
        avgLatencyMs: 0,
        validationFailures: 0,
      }
    }
    const total = Number(doc.total ?? 0)
    const totalLatencyMs = Number(doc.totalLatencyMs ?? 0)
    return {
      day,
      total,
      llm: Number(doc.llm ?? 0),
      heuristic: Number(doc.heuristic ?? 0),
      fallback: Number(doc.fallback ?? 0),
      modelCalls: Number(doc.modelCalls ?? 0),
      avgLatencyMs: total === 0 ? 0 : Math.round(totalLatencyMs / total),
      validationFailures: Number(doc.validationFailures ?? 0),
    }
  }

  async close(): Promise<void> {
    // Conexao e fechada por providers/mongoose (disconnectDB).
  }
}
