/**
 * Jikan client tests — global token-bucket pacing (1 req/sec sustained,
 * burst 3) and retry/backoff behaviour. Fake timers throughout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: { syncJobLog: { create: vi.fn().mockResolvedValue({}) } },
}));

function okResponse(body: unknown = { data: [] }): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    headers: new Headers(),
  } as unknown as Response;
}

function errResponse(status: number, headers: Record<string, string> = {}): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
    headers: new Headers(headers),
  } as unknown as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules(); // fresh token bucket per test
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("token bucket rate limiting", () => {
  it("allows a burst of 3 then spaces calls ≥ ~1s apart", async () => {
    const callTimes: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        callTimes.push(Date.now());
        return Promise.resolve(okResponse());
      }),
    );

    const { jikanFetch } = await import("../app/src/lib/catalog/jikanClient");
    const started = Date.now();
    const all = Promise.all(
      Array.from({ length: 10 }, (_, i) => jikanFetch(`/anime/${i}/full`)),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await all;

    expect(callTimes).toHaveLength(10);
    const offsets = callTimes.map((t) => t - started);
    // Burst: first 3 effectively immediate
    expect(offsets[2]).toBeLessThan(100);
    // Sustained: each call after the burst spaced ~1s from its predecessor
    for (let i = 3; i < offsets.length; i++) {
      expect(offsets[i] - offsets[i - 1]).toBeGreaterThanOrEqual(900);
    }
    // 10 calls with burst 3 at 1 rps ≈ 7s minimum total
    expect(offsets[9]).toBeGreaterThanOrEqual(6_500);
  });
});

describe("retry behaviour", () => {
  it("retries on 429 honouring Retry-After, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errResponse(429, { "retry-after": "3" }))
      .mockResolvedValueOnce(okResponse({ data: { mal_id: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    const { jikanFetch } = await import("../app/src/lib/catalog/jikanClient");
    const promise = jikanFetch<{ data: { mal_id: number } }>("/anime/1/full");
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result.data.mal_id).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries 5xx with exponential backoff up to 3 retries then throws", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(500));
    vi.stubGlobal("fetch", fetchMock);

    const { jikanFetch, JikanError } = await import("../app/src/lib/catalog/jikanClient");
    const promise = jikanFetch("/anime/1/full");
    const assertion = expect(promise).rejects.toBeInstanceOf(JikanError);
    await vi.advanceTimersByTimeAsync(60_000); // 2s + 4s + 8s backoff windows
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it("does NOT retry 404 and flags it as not-found", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(404));
    vi.stubGlobal("fetch", fetchMock);

    const { jikanFetch, JikanError } = await import("../app/src/lib/catalog/jikanClient");
    const promise = jikanFetch("/anime/0/full");
    promise.catch(() => {}); // observed below
    await vi.advanceTimersByTimeAsync(5_000);

    try {
      await promise;
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JikanError);
      expect((err as InstanceType<typeof JikanError>).isNotFound).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
