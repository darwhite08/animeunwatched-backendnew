import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    endpointStat: { findMany: vi.fn() },
    costRate:     { findMany: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    costBudget:   { findUnique: vi.fn(), upsert: vi.fn() },
  },
}))
vi.mock("../app/src/lib/adminAudit", () => ({ adminAuditR: vi.fn(async () => undefined) }))

import * as ctrl from "../app/src/modules/admin/cost.controller"

function ctx(body: Record<string, unknown> = {}, params: Record<string, string> = {}, query: Record<string, string> = {}): { req: Request; res: Response; next: NextFunction; jsonMock: ReturnType<typeof vi.fn> } {
  const jsonMock = vi.fn()
  const res = { status: vi.fn().mockReturnThis(), json: jsonMock, locals: { user: { id: "actor" } } } as unknown as Response
  return { req: { body, params, query } as unknown as Request, res, next: vi.fn() as NextFunction, jsonMock }
}

describe("cost.controller.getOverview", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("multiplies request count by per-1k rate", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      endpointStat: { findMany: ReturnType<typeof vi.fn> }
      costRate: { findMany: ReturnType<typeof vi.fn> }
      costBudget: { findUnique: ReturnType<typeof vi.fn> }
    }
    prisma.endpointStat.findMany.mockResolvedValue([
      { endpoint: "GET /a", requests: 1000, errors: 0, hourBucket: new Date() },
      { endpoint: "GET /a", requests: 1000, errors: 0, hourBucket: new Date() },
      { endpoint: "GET /b", requests: 500,  errors: 0, hourBucket: new Date() },
    ])
    prisma.costRate.findMany.mockResolvedValue([
      { endpoint: "GET /a", centsPer1k: 200, category: "db_heavy" },        // $0.02 / 1000 = $0.04 for 2000
      { endpoint: "GET /b", centsPer1k: 100, category: "cache_hit" },       // $0.01 / 1000 = $0.005 for 500
    ])
    prisma.costBudget.findUnique.mockResolvedValue(null)
    const { req, res, next, jsonMock } = ctx()
    await ctrl.getOverview(req, res, next)
    const p = jsonMock.mock.calls[0][0]
    expect(p.totalRequests).toBe(2500)
    expect(p.totalCostDollars).toBeCloseTo(0.045, 4)
    expect(p.endpoints[0].endpoint).toBe("GET /a")  // sorted by cost desc
    expect(p.endpoints[0].costDollars).toBeCloseTo(0.04, 4)
  })

  it("flags 'over' budget when total exceeds monthly budget", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      endpointStat: { findMany: ReturnType<typeof vi.fn> }
      costRate: { findMany: ReturnType<typeof vi.fn> }
      costBudget: { findUnique: ReturnType<typeof vi.fn> }
    }
    prisma.endpointStat.findMany.mockResolvedValue([
      { endpoint: "GET /a", requests: 100_000_000, errors: 0, hourBucket: new Date() },
    ])
    prisma.costRate.findMany.mockResolvedValue([
      { endpoint: "GET /a", centsPer1k: 10000, category: null },           // $1.00 / 1000 ⇒ $100k for 100M requests
    ])
    prisma.costBudget.findUnique.mockResolvedValue({ monthlyBudgetCents: BigInt(100), alertAtPct: 80 })  // budget is $0.01
    const { req, res, next, jsonMock } = ctx()
    await ctrl.getOverview(req, res, next)
    const p = jsonMock.mock.calls[0][0]
    expect(p.budget.status).toBe("over")
  })
})

describe("cost.controller mutations", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("upsertRate rejects negative cents", async () => {
    const { req, res, next } = ctx({ endpoint: "GET /x", centsPer1k: -1 })
    await ctrl.upsertRate(req, res, next)
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(err.status).toBe(400)
  })

  it("setBudget converts dollars to internal units", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      costBudget: { upsert: ReturnType<typeof vi.fn> }
    }
    prisma.costBudget.upsert.mockResolvedValue({ id: "b1" })
    const { req, res, next } = ctx({ monthlyBudgetDollars: 100, alertAtPct: 80 })
    await ctrl.setBudget(req, res, next)
    expect(prisma.costBudget.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ monthlyBudgetCents: BigInt(100 * 10000) }),
    }))
  })

  it("setBudget rejects out-of-range alertAtPct", async () => {
    const { req, res, next } = ctx({ monthlyBudgetDollars: 50, alertAtPct: 150 })
    await ctrl.setBudget(req, res, next)
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(err.status).toBe(400)
  })
})
