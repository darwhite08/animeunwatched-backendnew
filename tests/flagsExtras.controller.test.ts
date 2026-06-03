import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    featureFlag:         { findUnique: vi.fn(), update: vi.fn() },
    endpointStat:        { findMany: vi.fn() },
    featureFlagOverride: { count: vi.fn() },
    auditLog:            { findMany: vi.fn() },
  },
}))
vi.mock("../app/src/lib/adminAudit", () => ({ adminAuditR: vi.fn(async () => undefined) }))

import { getFlagImpact, setRolloutPercent } from "../app/src/modules/admin/flagsExtras.controller"

function ctx(body: Record<string, unknown> = {}, params: Record<string, string> = {}): { req: Request; res: Response; next: NextFunction; jsonMock: ReturnType<typeof vi.fn>; statusMock: ReturnType<typeof vi.fn> } {
  const jsonMock = vi.fn()
  const statusMock = vi.fn(function (this: Response) { return this })
  const res = { status: statusMock.mockReturnThis(), json: jsonMock, locals: { user: { id: "actor" } } } as unknown as Response
  return { req: { body, params } as unknown as Request, res, next: vi.fn() as NextFunction, jsonMock, statusMock }
}

describe("flagsExtras.getFlagImpact", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("returns scaled reach when not enabled globally", async () => {
    const p = (await import("../app/src/config/prisma")).prisma as unknown as {
      featureFlag: { findUnique: ReturnType<typeof vi.fn> }
      endpointStat: { findMany: ReturnType<typeof vi.fn> }
      featureFlagOverride: { count: ReturnType<typeof vi.fn> }
    }
    p.featureFlag.findUnique.mockResolvedValue({
      id: "f1", key: "x", enabledGlobally: false,
      rolloutRules: { percentage: 25 }, isKillSwitch: false, killedAt: null, lastEvaluatedAt: null,
    })
    p.endpointStat.findMany.mockResolvedValue([
      { requests: 1000, errors: 10, hourBucket: new Date() },
      { requests: 3000, errors: 5,  hourBucket: new Date() },
    ])
    p.featureFlagOverride.count.mockResolvedValue(2)

    const { req, res, next, jsonMock } = ctx({}, { id: "f1" })
    await getFlagImpact(req, res, next)
    const payload = jsonMock.mock.calls[0][0]
    expect(payload.totalRequests).toBe(4000)
    expect(payload.estimatedReachedRequests).toBe(1000)   // 4000 × 25%
    expect(payload.rolloutPct).toBe(25)
    expect(payload.overrides).toBe(2)
    expect(payload.errorRatePct).toBeCloseTo(0.38, 2)     // 15/4000
  })

  it("returns full reach when globally enabled", async () => {
    const p = (await import("../app/src/config/prisma")).prisma as unknown as {
      featureFlag: { findUnique: ReturnType<typeof vi.fn> }
      endpointStat: { findMany: ReturnType<typeof vi.fn> }
      featureFlagOverride: { count: ReturnType<typeof vi.fn> }
    }
    p.featureFlag.findUnique.mockResolvedValue({
      id: "f1", key: "x", enabledGlobally: true,
      rolloutRules: { percentage: 50 }, isKillSwitch: false, killedAt: null, lastEvaluatedAt: null,
    })
    p.endpointStat.findMany.mockResolvedValue([{ requests: 1000, errors: 0, hourBucket: new Date() }])
    p.featureFlagOverride.count.mockResolvedValue(0)
    const { req, res, next, jsonMock } = ctx({}, { id: "f1" })
    await getFlagImpact(req, res, next)
    expect(jsonMock.mock.calls[0][0].estimatedReachedRequests).toBe(1000)
  })

  it("404s when flag not found", async () => {
    const p = (await import("../app/src/config/prisma")).prisma as unknown as { featureFlag: { findUnique: ReturnType<typeof vi.fn> } }
    p.featureFlag.findUnique.mockResolvedValue(null)
    const { req, res, next } = ctx({}, { id: "nope" })
    await getFlagImpact(req, res, next)
    expect((next as ReturnType<typeof vi.fn>).mock.calls[0][0].status).toBe(404)
  })
})

describe("flagsExtras.setRolloutPercent", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("rejects values < 0 or > 100", async () => {
    const { req, res, statusMock } = ctx({ percentage: -1 }, { id: "f1" })
    await setRolloutPercent(req, res, vi.fn() as NextFunction)
    expect(statusMock).toHaveBeenCalledWith(400)

    const ctx2 = ctx({ percentage: 101 }, { id: "f1" })
    await setRolloutPercent(ctx2.req, ctx2.res, vi.fn() as NextFunction)
    expect(ctx2.statusMock).toHaveBeenCalledWith(400)
  })

  it("merges percentage into existing rolloutRules", async () => {
    const p = (await import("../app/src/config/prisma")).prisma as unknown as {
      featureFlag: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
    }
    p.featureFlag.findUnique.mockResolvedValue({
      id: "f1", key: "x", rolloutRules: { percentage: 10, cohorts: ["beta"] },
    })
    p.featureFlag.update.mockResolvedValue({ id: "f1" })
    const { req, res, next } = ctx({ percentage: 50 }, { id: "f1" })
    await setRolloutPercent(req, res, next)
    expect(p.featureFlag.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { rolloutRules: { percentage: 50, cohorts: ["beta"] } },
    }))
  })
})
