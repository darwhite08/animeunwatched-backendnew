type CacheEntry<T> = { data: T; expiresAt: number }

class SimpleCache {
  private store = new Map<string, CacheEntry<unknown>>()

  get<T>(key: string): T | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) { this.store.delete(key); return null }
    return entry.data as T
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs })
  }

  del(key: string): void { this.store.delete(key) }

  delPattern(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key)
    }
  }

  get size() { return this.store.size }
}

export const cache = new SimpleCache()

// Clean up expired entries every 5 min
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of (cache as any).store.entries()) {
    if (now > entry.expiresAt) (cache as any).store.delete(key)
  }
}, 5 * 60_000)
