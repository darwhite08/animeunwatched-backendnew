/**
 * In-memory cache unit tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// We need a fresh cache for each test group
function makeCache() {
  type CacheEntry<T> = { data: T; expiresAt: number };
  class SimpleCache {
    private store = new Map<string, CacheEntry<unknown>>();
    get<T>(key: string): T | null {
      const entry = this.store.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) { this.store.delete(key); return null; }
      return entry.data as T;
    }
    set<T>(key: string, data: T, ttlMs: number): void {
      this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
    }
    del(key: string): void { this.store.delete(key); }
    delPattern(prefix: string): void {
      for (const key of this.store.keys()) {
        if (key.startsWith(prefix)) this.store.delete(key);
      }
    }
    get size() { return this.store.size; }
  }
  return new SimpleCache();
}

describe("SimpleCache", () => {
  let cache: ReturnType<typeof makeCache>;

  beforeEach(() => {
    cache = makeCache();
    vi.useRealTimers();
  });

  it("stores and retrieves a value", () => {
    cache.set("key1", { name: "Naruto" }, 60_000);
    expect(cache.get("key1")).toEqual({ name: "Naruto" });
  });

  it("returns null for missing keys", () => {
    expect(cache.get("nonexistent")).toBeNull();
  });

  it("expires entries after TTL", () => {
    vi.useFakeTimers();
    cache.set("short", "value", 100);
    expect(cache.get("short")).toBe("value");
    vi.advanceTimersByTime(200);
    expect(cache.get("short")).toBeNull();
    vi.useRealTimers();
  });

  it("del removes a specific key", () => {
    cache.set("a", 1, 60_000);
    cache.set("b", 2, 60_000);
    cache.del("a");
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe(2);
  });

  it("delPattern removes matching keys", () => {
    cache.set("anime:1", "one", 60_000);
    cache.set("anime:2", "two", 60_000);
    cache.set("user:1",  "usr", 60_000);
    cache.delPattern("anime:");
    expect(cache.get("anime:1")).toBeNull();
    expect(cache.get("anime:2")).toBeNull();
    expect(cache.get("user:1")).toBe("usr");
  });

  it("tracks size correctly", () => {
    expect(cache.size).toBe(0);
    cache.set("x", 1, 60_000);
    cache.set("y", 2, 60_000);
    expect(cache.size).toBe(2);
    cache.del("x");
    expect(cache.size).toBe(1);
  });

  it("overwrites existing key", () => {
    cache.set("k", "first",  60_000);
    cache.set("k", "second", 60_000);
    expect(cache.get("k")).toBe("second");
  });
});
