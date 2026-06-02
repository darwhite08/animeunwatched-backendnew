import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    maintenanceWindow: { findMany: vi.fn() },
    incident:          { findMany: vi.fn() },
  },
}))

import { publicStatus } from "../app/src/modules/status/status.controller"

function ctx(): { req: Request; res: Response; next: NextFunction; jsonMock: ReturnType<typeof vi.fn> } {
  const jsonMock = vi.fn()
  const res = { status: vi.fn().mockReturnThis(), json: jsonMock } as unknown as Response
  return { req: {} as Request, res, next: vi.fn() as NextFunction, jsonMock }
}

describe("publicStatus", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("reports 'operational' with no incidents + no maintenance", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      maintenanceWindow: { findMany: ReturnType<typeof vi.fn> }
      incident:          { findMany: ReturnType<typeof vi.fn> }
    }
    prisma.maintenanceWindow.findMany.mockResolvedValue([])
    prisma.incident.findMany.mockResolvedValue([])
    const { req, res, next, jsonMock } = ctx()
    await publicStatus(req, res, next)
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ overall: "operational" }))
  })

  it("reports 'maintenance' when a window is active", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      maintenanceWindow: { findMany: ReturnType<typeof vi.fn> }
      incident:          { findMany: ReturnType<typeof vi.fn> }
    }
    prisma.maintenanceWindow.findMany
      .mockResolvedValueOnce([{ id: "m-1", title: "x", scope: "all", startsAt: new Date(), endsAt: new Date(Date.now()+60_000), description: null }])
      .mockResolvedValueOnce([])
    prisma.incident.findMany.mockResolvedValue([])
    const { req, res, next, jsonMock } = ctx()
    await publicStatus(req, res, next)
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ overall: "maintenance" }))
  })

  it("reports 'major_outage' when a sev1 is open", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      maintenanceWindow: { findMany: ReturnType<typeof vi.fn> }
      incident:          { findMany: ReturnType<typeof vi.fn> }
    }
    prisma.maintenanceWindow.findMany.mockResolvedValue([])
    prisma.incident.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "i-1", title: "down", severity: "sev1", status: "open", startedAt: new Date() }])
    const { req, res, next, jsonMock } = ctx()
    await publicStatus(req, res, next)
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ overall: "major_outage" }))
  })
})
