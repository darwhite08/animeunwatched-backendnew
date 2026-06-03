import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    incident:          { findMany: vi.fn() },
    maintenanceWindow: { findMany: vi.fn() },
    syntheticMonitor:  { findMany: vi.fn() },
    backupRecord:      { findFirst: vi.fn() },
    adminAlert:        { count: vi.fn() },
    sloDefinition:     { findMany: vi.fn() },
    endpointStat:      { findMany: vi.fn() },
  },
}))

import { getPlatformHealthOverview } from "../app/src/modules/admin/platformHealth.controller"

function ctx(): { req: Request; res: Response; next: NextFunction; jsonMock: ReturnType<typeof vi.fn> } {
  const jsonMock = vi.fn()
  const res = { status: vi.fn().mockReturnThis(), json: jsonMock } as unknown as Response
  return { req: {} as Request, res, next: vi.fn() as NextFunction, jsonMock }
}

describe("platformHealth.getOverview", () => {
  beforeEach(() => { vi.clearAllMocks() })

  async function setupAllGreen() {
    const p = ((await import("../app/src/config/prisma")) as unknown as { prisma: Record<string, Record<string, ReturnType<typeof vi.fn>>> }).prisma
    p.incident.findMany.mockResolvedValue([])
    p.maintenanceWindow.findMany.mockResolvedValue([])
    p.syntheticMonitor.findMany.mockResolvedValue([])
    p.backupRecord.findFirst.mockResolvedValue({ completedAt: new Date(Date.now() - 60_000) })  // 1m old
    p.adminAlert.count.mockResolvedValue(0)
    p.sloDefinition.findMany.mockResolvedValue([])
    p.endpointStat.findMany.mockResolvedValue([])
  }

  it("reports 'operational' when every signal is clean", async () => {
    await setupAllGreen()
    const { req, res, next, jsonMock } = ctx()
    await getPlatformHealthOverview(req, res, next)
    expect(jsonMock.mock.calls[0][0].overall).toBe("operational")
  })

  it("escalates to 'outage' on a sev1 open incident", async () => {
    await setupAllGreen()
    const p = ((await import("../app/src/config/prisma")) as unknown as { prisma: Record<string, Record<string, ReturnType<typeof vi.fn>>> }).prisma
    p.incident.findMany.mockResolvedValue([{ id: "i1", severity: "sev1", status: "open", title: "DB down", startedAt: new Date() }])
    const { req, res, next, jsonMock } = ctx()
    await getPlatformHealthOverview(req, res, next)
    expect(jsonMock.mock.calls[0][0].overall).toBe("outage")
  })

  it("escalates to 'outage' on overdue backup", async () => {
    await setupAllGreen()
    const p = ((await import("../app/src/config/prisma")) as unknown as { prisma: Record<string, Record<string, ReturnType<typeof vi.fn>>> }).prisma
    p.backupRecord.findFirst.mockResolvedValue({ completedAt: new Date(Date.now() - 30 * 60 * 60_000) })  // 30h old
    const { req, res, next, jsonMock } = ctx()
    await getPlatformHealthOverview(req, res, next)
    expect(jsonMock.mock.calls[0][0].overall).toBe("outage")
    expect(jsonMock.mock.calls[0][0].signals.backups.overdue).toBe(true)
  })

  it("escalates to 'outage' on unacked critical alerts", async () => {
    await setupAllGreen()
    const p = ((await import("../app/src/config/prisma")) as unknown as { prisma: Record<string, Record<string, ReturnType<typeof vi.fn>>> }).prisma
    p.adminAlert.count.mockResolvedValue(3)
    const { req, res, next, jsonMock } = ctx()
    await getPlatformHealthOverview(req, res, next)
    expect(jsonMock.mock.calls[0][0].overall).toBe("outage")
  })

  it("degrades to 'degraded' on failing monitor without bigger issues", async () => {
    await setupAllGreen()
    const p = ((await import("../app/src/config/prisma")) as unknown as { prisma: Record<string, Record<string, ReturnType<typeof vi.fn>>> }).prisma
    p.syntheticMonitor.findMany.mockResolvedValue([
      { id: "m1", name: "login", lastOutcome: "fail",   lastLatencyMs: 5_000, lastRunAt: new Date() },
      { id: "m2", name: "feed",  lastOutcome: "ok",     lastLatencyMs: 100,   lastRunAt: new Date() },
    ])
    const { req, res, next, jsonMock } = ctx()
    await getPlatformHealthOverview(req, res, next)
    expect(jsonMock.mock.calls[0][0].overall).toBe("degraded")
    expect(jsonMock.mock.calls[0][0].signals.synthetics.failing).toBe(1)
  })

  it("degrades to 'degraded' during active maintenance", async () => {
    await setupAllGreen()
    const p = ((await import("../app/src/config/prisma")) as unknown as { prisma: Record<string, Record<string, ReturnType<typeof vi.fn>>> }).prisma
    p.maintenanceWindow.findMany.mockResolvedValue([{ id: "m1", title: "patch", scope: "all", endsAt: new Date(Date.now() + 60_000) }])
    const { req, res, next, jsonMock } = ctx()
    await getPlatformHealthOverview(req, res, next)
    expect(jsonMock.mock.calls[0][0].overall).toBe("degraded")
  })
})
