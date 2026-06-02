import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => {
  const incident = {
    findMany:   vi.fn(),
    findUnique: vi.fn(),
    create:     vi.fn(),
    update:     vi.fn(),
  }
  const incidentUpdate = { create: vi.fn() }
  const adminAlert = { create: vi.fn() }
  return { prisma: { incident, incidentUpdate, adminAlert } }
})

vi.mock("../app/src/lib/adminAudit", () => ({
  adminAuditR: vi.fn(async () => undefined),
}))

import * as ctrl from "../app/src/modules/admin/incidents.controller"

function ctx(body: Record<string, unknown> = {}, params: Record<string, string> = {}): { req: Request; res: Response; next: NextFunction; jsonMock: ReturnType<typeof vi.fn> } {
  const jsonMock = vi.fn()
  const res = {
    status:  vi.fn().mockReturnThis(),
    json:    jsonMock,
    locals: { user: { id: "actor-1" } },
  } as unknown as Response
  const req = { body, params, query: {} } as unknown as Request
  return { req, res, next: vi.fn() as NextFunction, jsonMock }
}

describe("incidents.controller", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("createIncident persists + writes opening update + raises alert for sev1", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      incident: { create: ReturnType<typeof vi.fn> }
      incidentUpdate: { create: ReturnType<typeof vi.fn> }
      adminAlert: { create: ReturnType<typeof vi.fn> }
    }
    prisma.incident.create.mockResolvedValue({ id: "inc-1", title: "API down", severity: "sev1" })
    prisma.incidentUpdate.create.mockResolvedValue({})
    prisma.adminAlert.create.mockResolvedValue({})
    const { req, res, next } = ctx({ title: "API down", severity: "sev1", category: "api" })
    await ctrl.createIncident(req, res, next)
    expect(prisma.incident.create).toHaveBeenCalled()
    expect(prisma.incidentUpdate.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "open" }) }))
    expect(prisma.adminAlert.create).toHaveBeenCalled()
  })

  it("createIncident rejects unknown severity", async () => {
    const { req, res, next } = ctx({ title: "x", severity: "sev99", category: "api" })
    await ctrl.createIncident(req, res, next)
    expect(next).toHaveBeenCalled()
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(err.status).toBe(400)
  })

  it("appendUpdate flips status to resolved + sets resolvedAt", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      incident: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
      incidentUpdate: { create: ReturnType<typeof vi.fn> }
    }
    prisma.incident.findUnique.mockResolvedValue({ id: "inc-1", status: "monitoring" })
    prisma.incidentUpdate.create.mockResolvedValue({ id: "u-1" })
    prisma.incident.update.mockResolvedValue({})
    const { req, res, next } = ctx({ status: "resolved", message: "All clear" }, { id: "inc-1" })
    await ctrl.appendUpdate(req, res, next)
    expect(prisma.incident.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "resolved", resolvedAt: expect.any(Date) }) }),
    )
  })
})
