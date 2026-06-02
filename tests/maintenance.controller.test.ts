import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    maintenanceWindow: {
      findMany:   vi.fn(),
      findUnique: vi.fn(),
      create:     vi.fn(),
      update:     vi.fn(),
      delete:     vi.fn(),
    },
  },
}))
vi.mock("../app/src/lib/adminAudit", () => ({ adminAuditR: vi.fn(async () => undefined) }))

import * as ctrl from "../app/src/modules/admin/maintenance.controller"

function ctx(body: Record<string, unknown> = {}, params: Record<string, string> = {}): { req: Request; res: Response; next: NextFunction } {
  const res = {
    status:  vi.fn().mockReturnThis(),
    json:    vi.fn(),
    locals: { user: { id: "actor-1" } },
  } as unknown as Response
  return { req: { body, params } as unknown as Request, res, next: vi.fn() as NextFunction }
}

describe("maintenance.controller", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("createMaintenance rejects endsAt ≤ startsAt", async () => {
    const { req, res, next } = ctx({
      title: "test", startsAt: "2099-01-01T00:00:00Z", endsAt: "2099-01-01T00:00:00Z",
    })
    await ctrl.createMaintenance(req, res, next)
    expect(next).toHaveBeenCalled()
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(err.status).toBe(400)
  })

  it("currentMaintenance returns active windows", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      maintenanceWindow: { findMany: ReturnType<typeof vi.fn> }
    }
    prisma.maintenanceWindow.findMany.mockResolvedValue([{ id: "m-1", title: "Patch", scope: "all" }])
    const { req, res, next } = ctx()
    await ctrl.currentMaintenance(req, res, next)
    expect(prisma.maintenanceWindow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ cancelledAt: null }) }),
    )
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.any(Array) }))
  })

  it("cancelMaintenance is idempotent (already cancelled → return as-is)", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      maintenanceWindow: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
    }
    prisma.maintenanceWindow.findUnique.mockResolvedValue({ id: "m-1", cancelledAt: new Date(), title: "x" })
    const { req, res, next } = ctx({}, { id: "m-1" })
    await ctrl.cancelMaintenance(req, res, next)
    expect(prisma.maintenanceWindow.update).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalled()
  })
})
