/**
 * Advanced cache tests — TTL edge cases, concurrent operations.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cache } from "../app/src/lib/cache";

describe("cache — advanced TTL behavior", () => {
  beforeEach(() => {
    vi.useRealTimers();
    // Clear cache between tests
    cache.delPattern("");  // Note: empty prefix matches nothing, use specific cleanup
  });

  it("del removes entry immediately", () => {
    cache.set("test-key", "test-value", 60_000);
    expect(cache.get("test-key")).toBe("test-value");
    cache.del("test-key");
    expect(cache.get("test-key")).toBeNull();
  });

  it("set overwrites existing TTL", () => {
    vi.useFakeTimers();
    cache.set("ttl-key", "first", 100); // expires in 100ms
    cache.set("ttl-key", "second", 60_000); // new TTL: 1 min

    vi.advanceTimersByTime(200); // past original TTL
    expect(cache.get("ttl-key")).toBe("second"); // still valid with new TTL
    vi.useRealTimers();
  });

  it("delPattern with common prefix removes multiple entries", () => {
    cache.set("anime:1", "one",   60_000);
    cache.set("anime:2", "two",   60_000);
    cache.set("anime:3", "three", 60_000);
    cache.set("user:1",  "user",  60_000);

    cache.delPattern("anime:");

    expect(cache.get("anime:1")).toBeNull();
    expect(cache.get("anime:2")).toBeNull();
    expect(cache.get("anime:3")).toBeNull();
    expect(cache.get("user:1")).toBe("user"); // not deleted
  });

  it("get returns correct types for different value types", () => {
    cache.set("str", "hello", 60_000);
    cache.set("num", 42, 60_000);
    cache.set("obj", { name: "Naruto" }, 60_000);
    cache.set("arr", [1, 2, 3], 60_000);
    cache.set("bool", true, 60_000);

    expect(cache.get<string>("str")).toBe("hello");
    expect(cache.get<number>("num")).toBe(42);
    expect(cache.get<{ name: string }>("obj")).toEqual({ name: "Naruto" });
    expect(cache.get<number[]>("arr")).toEqual([1, 2, 3]);
    expect(cache.get<boolean>("bool")).toBe(true);

    cache.del("str");
    cache.del("num");
    cache.del("obj");
    cache.del("arr");
    cache.del("bool");
  });

  it("size reflects only non-expired entries (after expiry check)", () => {
    vi.useFakeTimers();

    const initial = cache.size;
    cache.set("temp-1", "val1", 100);
    cache.set("temp-2", "val2", 100);

    expect(cache.size).toBe(initial + 2);

    vi.advanceTimersByTime(200);

    // Trigger expiry check via get
    cache.get("temp-1");
    cache.get("temp-2");

    expect(cache.size).toBe(initial);
    vi.useRealTimers();
  });
});
