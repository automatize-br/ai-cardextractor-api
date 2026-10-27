import { env } from '../config/env.ts'

// ============================================================================
// Cache de aplicação (LRU + TTL). Guarda apenas resultados válidos.
// `AI_APP_CACHE=off` desabilita; `memory` é o default single-instance.
// ============================================================================

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

class AppCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>()

  get(key: string): T | null {
    if (env.AI_APP_CACHE === 'off') return null
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return null
    }
    // LRU: move para o fim.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: T): void {
    if (env.AI_APP_CACHE === 'off') return
    const ttl = Math.max(1, env.AI_APP_CACHE_TTL_MS)
    const max = Math.max(1, env.AI_APP_CACHE_MAX)
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: Date.now() + ttl })
    while (this.entries.size > max) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

export const appCache = new AppCache<unknown>()

export function resetAppCacheForTests(): void {
  appCache.clear()
}
