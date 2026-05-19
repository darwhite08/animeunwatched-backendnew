/**
 * Advanced rate limiting tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

function makeLimiter(limit: number, windowMs: number) {
  const store = new Map<string, { count: number; resetAt: number }>();
  return function(req: Request, res: Response, next: NextFunction) {
    const key = (req.ip as string) ?? "unknown";
    const now = Date.now();
    const entry = store.get(key);
    res.set("X-RateLimit-Limit", String(limit));
    if (!entry || now > entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      res.set("X-RateLimit-Remaining", String(limit - 1));
      return next();
    }
    if (entry.count >= limit) {
      res.set("X-RateLimit-Remaining", "0");
      res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      return;
    }
    entry.count++;
    res.set("X-RateLimit-Remaining", String(Math.max(0, limit - entry.count)));
    next();
  };
}

function makeReq(ip = "127.0.0.1"): Request {
  return { ip, headers: {}, body: {}, params: {}, query: {} } as unknown as Request;
}

function makeRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    set: vi.fn(),
  };
}

describe("rate limiter — multiple IPs", () => {
  beforeEach(() => vi.useRealTimers());

  it("limits each IP independently with limit=1", () => {
    const limiter = makeLimiter(1, 60_000);
    const ips = ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4", "5.5.5.5"];

    for (const ip of ips) {
      // First request for each IP should pass
      const next = vi.fn();
      const res = makeRes();
      limiter(makeReq(ip), res as any, next);
      expect(next).toHaveBeenCalledOnce();

      // Second request for same IP should be blocked
      const next2 = vi.fn();
      const res2 = makeRes();
      limiter(makeReq(ip), res2 as any, next2);
      expect(next2).not.toHaveBeenCalled();
      expect(res2.status).toHaveBeenCalledWith(429);
    }
  });

  it("sets X-RateLimit-Remaining correctly", () => {
    const limiter = makeLimiter(5, 60_000);
    const req = makeReq("10.0.0.1");

    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      const next = vi.fn();
      limiter(req, res as any, next);
      expect(res.set).toHaveBeenCalledWith("X-RateLimit-Remaining", String(5 - 1 - i));
    }
  });

  it("X-RateLimit-Limit is always the configured limit", () => {
    const limiter = makeLimiter(10, 60_000);
    const res = makeRes();
    limiter(makeReq(), res as any, vi.fn());
    expect(res.set).toHaveBeenCalledWith("X-RateLimit-Limit", "10");
  });

  it("allows exactly `limit` requests in window", () => {
    const limit = 3;
    const limiter = makeLimiter(limit, 60_000);
    const req = makeReq("unique-ip");

    for (let i = 0; i < limit; i++) {
      const next = vi.fn();
      limiter(req, makeRes() as any, next);
      expect(next).toHaveBeenCalledOnce();
    }

    // (limit + 1)th request should be blocked
    const next = vi.fn();
    const res = makeRes();
    limiter(req, res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });
});
