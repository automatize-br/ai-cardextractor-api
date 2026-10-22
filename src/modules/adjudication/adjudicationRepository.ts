import { getPersistence } from '../../providers/persistence/index.ts'
import type { AdjudicationRecord } from '../../types/persistence.ts'
import type { AdjudicationStats } from '../../types/adjudication.ts'

export default class AdjudicationRepository {
  static async save(record: AdjudicationRecord): Promise<void> {
    await getPersistence().save(record)
  }

  static async stats(day: string): Promise<AdjudicationStats> {
    return getPersistence().stats(day)
  }
}
