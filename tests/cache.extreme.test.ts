/**
 * Extreme cache tests — high volume, concurrent-like operations.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cache } from "../app/src/lib/cache";

describe("cache — high volume operations", () => {
  beforeEach(() => {
    // Clear test keys
    cache.delPattern("test:")
    vi.useRealTimers()
  })

  it("handles 100 simultaneous set operations", () => {
    for (let i = 0; i < 100; i++) {
      cache.set(`test:${i}`, { index: i, data: `value-${i}` }, 60_000)
    }
    for (let i = 0; i < 100; i++) {
      expect(cache.get<{ index: number }>(`test:${i}`)?.index).toBe(i)
    }
    cache.delPattern("test:")
  })

  it("handles rapid get-set cycles", () => {
    const key = "test:rapid"
    for (let i = 0; i < 50; i++) {
      cache.set(key, i, 60_000)
      expect(cache.get<number>(key)).toBe(i)
    }
    cache.del(key)
  })

  it("delPattern performance with many keys", () => {
    for (let i = 0; i < 50; i++) {
      cache.set(`test:a:${i}`, i, 60_000)
      cache.set(`test:b:${i}`, i, 60_000)
    }
    const before = cache.size
    cache.delPattern("test:a:")
    expect(cache.size).toBe(before - 50)
    cache.delPattern("test:b:")
  })

  it("handles large JSON values", () => {
    const large = { data: Array(1000).fill({ id: "x", title: "y", score: 8.5 }) }
    cache.set("test:large", large, 60_000)
    const result = cache.get<typeof large>("test:large")
    expect(result?.data).toHaveLength(1000)
    cache.del("test:large")
  })
})

describe("cache — TTL precision", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("entry valid at exactly TTL ms (not yet expired)", () => {
    cache.set("test:ttl", "value", 1000)
    vi.advanceTimersByTime(999) // 1ms before expiry
    expect(cache.get("test:ttl")).toBe("value")
    cache.del("test:ttl")
  })

  it("entry expired just after TTL ms", () => {
    cache.set("test:ttl2", "value", 1000)
    vi.advanceTimersByTime(1001) // 1ms after expiry
    expect(cache.get("test:ttl2")).toBeNull()
  })

  it("handles very short TTL (1ms)", () => {
    cache.set("test:short", "x", 1)
    vi.advanceTimersByTime(2)
    expect(cache.get("test:short")).toBeNull()
  })
})
