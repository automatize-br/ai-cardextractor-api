import { env } from '../../config/env.ts'
import { MemoryPersistence } from './memoryPersistence.ts'
import { MongoPersistence } from './mongoPersistence.ts'
import type { Persistence } from './types.ts'

let instance: Persistence | null = null

export function getPersistence(): Persistence {
  if (instance) return instance
  instance = env.AI_PERSISTENCE === 'mongo' ? new MongoPersistence() : new MemoryPersistence()
  return instance
}

export async function closePersistence(): Promise<void> {
  if (!instance) return
  await instance.close()
  instance = null
}

export type * from './types.ts'
