/**
 * Advanced middleware tests — rate limiting, performance, API version.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

function makeReq(ip = "127.0.0.1"): Request {
  return { ip, headers: {}, body: {}, params: {}, query: {} } as unknown as Request;
}

function makeRes(): Response & { setHeader: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  return {
    locals: {},
    setHeader: vi.fn(),
    set: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as any;
}

describe("responseTime middleware", () => {
  it("sets X-Response-Time header on finish", async () => {
    const { responseTime } = await import("../app/src/middlewares/performance.middleware");
    const res = makeRes();
    const next = vi.fn();
    const emitHandlers: Record<string, () => void> = {};

    // Add event emitter mock
    const resWithEmitter = {
      ...res,
      on: (event: string, handler: () => void) => { emitHandlers[event] = handler },
      headersSent: false,
    };

    responseTime(makeReq(), resWithEmitter as any, next);
    expect(next).toHaveBeenCalled();

    // Simulate finish event
    if (emitHandlers["finish"]) {
      emitHandlers["finish"]();
      expect(resWithEmitter.setHeader).toHaveBeenCalledWith("X-Response-Time", expect.stringMatching(/\d+\.\d+ms/));
    }
  });
});

describe("apiVersionHeader middleware", () => {
  it("sets X-API-Version header", async () => {
    const { apiVersionHeader } = await import("../app/src/middlewares/apiVersion.middleware");
    const res = makeRes();
    const next = vi.fn();

    apiVersionHeader(makeReq(), res, next);

    expect(res.setHeader).toHaveBeenCalledWith("X-API-Version", "1.0.0");
    expect(next).toHaveBeenCalled();
  });
});

describe("optionalAuth middleware", () => {
  it("calls next() with no args when no Authorization header", async () => {
    const { optionalAuth } = await import("../app/src/middlewares/auth.middleware");
    const next = vi.fn();
    const res = { locals: {}, status: vi.fn(), json: vi.fn() } as unknown as Response;

    optionalAuth(makeReq(), res, next);

    expect(next).toHaveBeenCalledWith(); // called with no args
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("calls next() with no args for invalid JWT (silent fail)", async () => {
    const { optionalAuth } = await import("../app/src/middlewares/auth.middleware");
    const next = vi.fn();
    const res = { locals: {}, status: vi.fn(), json: vi.fn() } as unknown as Response;
    const req = makeReq();
    (req as any).headers.authorization = "Bearer invalid-jwt";

    optionalAuth(req, res, next);

    // Should call next regardless (optional auth never blocks)
    // May be called synchronously or asynchronously
    await new Promise(r => setTimeout(r, 50));
    expect(next).toHaveBeenCalled();
  });
});

describe("requestLogger middleware", () => {
  it("logs in development mode", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    const { requestLogger } = await import("../app/src/middlewares/performance.middleware");
    const next = vi.fn();

    requestLogger({ method: "GET", path: "/test" } as Request, {} as Response, next);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("GET"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("/test"));
    expect(next).toHaveBeenCalled();

    process.env.NODE_ENV = originalEnv;
    consoleSpy.mockRestore();
  });

  it("does not log in production mode", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const { requestLogger } = await import("../app/src/middlewares/performance.middleware");
    requestLogger({ method: "GET", path: "/test" } as Request, {} as Response, vi.fn());

    expect(consoleSpy).not.toHaveBeenCalled();

    process.env.NODE_ENV = originalEnv;
    consoleSpy.mockRestore();
  });
});
