import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"
import { slaMetrics, flushSlaMetrics } from "../app/src/middlewares/slaMetrics.middleware"

// Mock prisma client used by the flush job
vi.mock("../app/src/config/prisma", () => {
  const endpointStat = {
    findUnique: vi.fn(),
    update:     vi.fn(),
    create:     vi.fn(),
  }
  return { prisma: { endpointStat } }
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockRes(statusCode: number, listeners: Record<string, Array<() => void>> = {}): { res: Response; fire: (event: string) => void } {
  const res = {
    statusCode,
    on: vi.fn((event: string, cb: () => void) => {
      listeners[event] = listeners[event] ?? []
      listeners[event].push(cb)
    }),
  } as unknown as Response
  return { res, fire: (event: string) => (listeners[event] ?? []).forEach(cb => cb()) }
}

function mockReq(method: string, path: string, route?: string): Request {
  return { method, path, baseUrl: "", route: route ? { path: route } : undefined } as Request
}

describe("slaMetrics middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("records a request on response finish", async () => {
    const mw = slaMetrics()
    const { res, fire } = mockRes(200)
    const next = vi.fn() as NextFunction
    mw(mockReq("GET", "/api/v1/anime"), res, next)
    fire("finish")
    // The bucket is in-memory; trigger flush and verify it persists.
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      endpointStat: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
    }
    prisma.endpointStat.findUnique.mockResolvedValue(null)
    prisma.endpointStat.create.mockResolvedValue({})
    const r = await flushSlaMetrics()
    expect(r.flushed).toBeGreaterThanOrEqual(1)
    expect(prisma.endpointStat.create).toHaveBeenCalled()
    const data = prisma.endpointStat.create.mock.calls[0][0].data
    expect(data.endpoint).toBe("GET /api/v1/anime")
    expect(data.requests).toBe(1)
  })

  it("classifies 5xx as errors and 4xx as clientErrors", async () => {
    const mw = slaMetrics()
    const handlers: Array<() => Promise<void>> = []
    for (const status of [200, 200, 404, 500]) {
      const { res, fire } = mockRes(status)
      mw(mockReq("GET", "/x", "/x"), res, vi.fn())
      handlers.push(async () => fire("finish"))
    }
    await Promise.all(handlers.map(h => h()))
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      endpointStat: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
    }
    prisma.endpointStat.findUnique.mockResolvedValue(null)
    prisma.endpointStat.create.mockResolvedValue({})
    await flushSlaMetrics()
    const data = prisma.endpointStat.create.mock.calls[0][0].data
    expect(data.requests).toBe(4)
    expect(data.errors).toBe(1)        // 500
    expect(data.clientErrors).toBe(1)  // 404
  })

  it("uses the route template so /:id calls collapse into one bucket", async () => {
    const mw = slaMetrics()
    for (const id of ["1", "2", "3"]) {
      const { res, fire } = mockRes(200)
      mw(mockReq("GET", `/u/${id}`, "/u/:id"), res, vi.fn())
      fire("finish")
    }
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      endpointStat: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
    }
    prisma.endpointStat.findUnique.mockResolvedValue(null)
    prisma.endpointStat.create.mockResolvedValue({})
    const r = await flushSlaMetrics()
    expect(r.flushed).toBe(1) // collapsed into one
    expect(prisma.endpointStat.create.mock.calls[0][0].data.endpoint).toBe("GET /u/:id")
    expect(prisma.endpointStat.create.mock.calls[0][0].data.requests).toBe(3)
  })

  it("never throws if the middleware-side bookkeeping errors", () => {
    const mw = slaMetrics()
    const { res, fire } = mockRes(200)
    expect(() => mw(mockReq("GET", "/x"), res, vi.fn())).not.toThrow()
    expect(() => fire("finish")).not.toThrow()
  })
})
