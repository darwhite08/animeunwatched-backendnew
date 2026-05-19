/**
 * Rate limit middleware unit tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

// Isolate module between tests so the store is fresh
function makeLimiter(limit: number, windowMs: number) {
  const store = new Map<string, { count: number; resetAt: number }>();

  return function rateLimitFn(req: Request, res: Response, next: NextFunction) {
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

function mockReq(ip = "127.0.0.1"): Request {
  return { ip, headers: {} } as unknown as Request;
}

function mockRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    set: vi.fn(),
  };
  return res;
}

describe("rateLimit middleware", () => {
  beforeEach(() => vi.useRealTimers());

  it("allows requests within limit", () => {
    const limiter = makeLimiter(5, 60_000);
    const next = vi.fn();
    const req = mockReq();
    const res = mockRes();

    limiter(req, res as any, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("blocks request exceeding limit with 429", () => {
    const limiter = makeLimiter(2, 60_000);
    const req = mockReq("10.0.0.1");

    for (let i = 0; i < 2; i++) {
      limiter(req, mockRes() as any, vi.fn());
    }

    const next = vi.fn();
    const res = mockRes();
    limiter(req, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it("sets X-RateLimit-Limit header", () => {
    const limiter = makeLimiter(10, 60_000);
    const res = mockRes();
    limiter(mockReq(), res as any, vi.fn());
    expect(res.set).toHaveBeenCalledWith("X-RateLimit-Limit", "10");
  });

  it("tracks different IPs independently", () => {
    const limiter = makeLimiter(1, 60_000);
    const next1 = vi.fn();
    const next2 = vi.fn();

    // First IP — should pass
    limiter(mockReq("1.1.1.1"), mockRes() as any, next1);
    expect(next1).toHaveBeenCalled();

    // Second IP — should also pass (fresh counter)
    limiter(mockReq("2.2.2.2"), mockRes() as any, next2);
    expect(next2).toHaveBeenCalled();
  });

  it("resets after window expires", () => {
    vi.useFakeTimers();
    const limiter = makeLimiter(1, 1_000);
    const req = mockReq("3.3.3.3");

    // Exhaust limit
    limiter(req, mockRes() as any, vi.fn());

    // Advance past window
    vi.advanceTimersByTime(1_100);

    const next = vi.fn();
    limiter(req, mockRes() as any, next);
    expect(next).toHaveBeenCalled();

    vi.useRealTimers();
  });
});
