import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    rateLimitOverride: { findMany: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    apiChangeLog:      { findMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
    deprecatedEndpoint:{ findMany: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    requestCapture:    { findMany: vi.fn(), delete: vi.fn() },
  },
}))
vi.mock("../app/src/lib/adminAudit", () => ({ adminAuditR: vi.fn(async () => undefined) }))

import * as ctrl from "../app/src/modules/admin/dx.controller"

function ctx(body: Record<string, unknown> = {}, params: Record<string, string> = {}, query: Record<string, string> = {}): { req: Request; res: Response; next: NextFunction; jsonMock: ReturnType<typeof vi.fn> } {
  const jsonMock = vi.fn()
  const res = { status: vi.fn().mockReturnThis(), json: jsonMock, locals: { user: { id: "actor" } } } as unknown as Response
  return { req: { body, params, query } as unknown as Request, res, next: vi.fn() as NextFunction, jsonMock }
}

describe("dx.controller — rate limits", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("rejects unknown subjectType", async () => {
    const { req, res, next } = ctx({ subjectType: "something_else", subjectId: "x", requestsPerWindow: 100, windowSeconds: 60 })
    await ctrl.upsertRateLimit(req, res, next)
    expect((next as ReturnType<typeof vi.fn>).mock.calls[0][0].status).toBe(400)
  })

  it("rejects non-positive limit", async () => {
    const { req, res, next } = ctx({ subjectType: "api_key", subjectId: "x", requestsPerWindow: 0, windowSeconds: 60 })
    await ctrl.upsertRateLimit(req, res, next)
    expect((next as ReturnType<typeof vi.fn>).mock.calls[0][0].status).toBe(400)
  })

  it("upserts on the composite key", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      rateLimitOverride: { upsert: ReturnType<typeof vi.fn> }
    }
    prisma.rateLimitOverride.upsert.mockResolvedValue({ id: "rl1" })
    const { req, res, next } = ctx({ subjectType: "oauth_client", subjectId: "ka_oc_x", requestsPerWindow: 500, windowSeconds: 60 })
    await ctrl.upsertRateLimit(req, res, next)
    expect(prisma.rateLimitOverride.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { subjectType_subjectId: { subjectType: "oauth_client", subjectId: "ka_oc_x" } },
    }))
  })
})

describe("dx.controller — changelog", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("rejects unknown changeType", async () => {
    const { req, res, next } = ctx({ title: "x", body: "y", changeType: "weird" })
    await ctrl.createChangelog(req, res, next)
    expect((next as ReturnType<typeof vi.fn>).mock.calls[0][0].status).toBe(400)
  })

  it("creates with empty affects array when not provided", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      apiChangeLog: { create: ReturnType<typeof vi.fn> }
    }
    prisma.apiChangeLog.create.mockResolvedValue({ id: "cl1" })
    const { req, res, next } = ctx({ title: "Test", body: "y", changeType: "feature" })
    await ctrl.createChangelog(req, res, next)
    expect(prisma.apiChangeLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ affects: [] }),
    }))
  })
})

describe("dx.controller — deprecations", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("rejects invalid sunset date", async () => {
    const { req, res, next } = ctx({ endpoint: "GET /x", sunsetAt: "not-a-date" })
    await ctrl.upsertDeprecation(req, res, next)
    expect((next as ReturnType<typeof vi.fn>).mock.calls[0][0].status).toBe(400)
  })

  it("upserts on endpoint key", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      deprecatedEndpoint: { upsert: ReturnType<typeof vi.fn> }
    }
    prisma.deprecatedEndpoint.upsert.mockResolvedValue({ id: "d1" })
    const { req, res, next } = ctx({ endpoint: "GET /api/v1/old", sunsetAt: "2099-01-01T00:00:00Z" })
    await ctrl.upsertDeprecation(req, res, next)
    expect(prisma.deprecatedEndpoint.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { endpoint: "GET /api/v1/old" },
    }))
  })
})
