import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    approvalRequest:  { findMany: vi.fn() },
    incident:         { findMany: vi.fn() },
    rtbfRequest:      { findMany: vi.fn() },
    anomalyEvent:     { findMany: vi.fn() },
    syntheticMonitor: { findMany: vi.fn() },
    adminAlert:       { findMany: vi.fn() },
    ticketWebhook:    { findMany: vi.fn() },
  },
}))

import { getInbox } from "../app/src/modules/admin/inbox.controller"

function ctx(): { req: Request; res: Response; next: NextFunction; jsonMock: ReturnType<typeof vi.fn> } {
  const jsonMock = vi.fn()
  const res = { status: vi.fn().mockReturnThis(), json: jsonMock } as unknown as Response
  return { req: {} as Request, res, next: vi.fn() as NextFunction, jsonMock }
}

describe("inbox.getInbox", () => {
  beforeEach(() => { vi.clearAllMocks() })

  async function setupEmpty() {
    const p = ((await import("../app/src/config/prisma")) as unknown as { prisma: Record<string, Record<string, ReturnType<typeof vi.fn>>> }).prisma
    for (const m of [p.approvalRequest, p.incident, p.rtbfRequest, p.anomalyEvent, p.syntheticMonitor, p.adminAlert, p.ticketWebhook]) {
      m.findMany.mockResolvedValue([])
    }
  }

  it("returns empty + zero counters when nothing needs attention", async () => {
    await setupEmpty()
    const { req, res, next, jsonMock } = ctx()
    await getInbox(req, res, next)
    const p = jsonMock.mock.calls[0][0]
    expect(p.items).toEqual([])
    expect(p.counters.total).toBe(0)
  })

  it("aggregates from all 7 sources + sorts by recency", async () => {
    await setupEmpty()
    const p = ((await import("../app/src/config/prisma")) as unknown as { prisma: Record<string, Record<string, ReturnType<typeof vi.fn>>> }).prisma
    const oldest = new Date("2026-01-01T00:00:00Z")
    const middle = new Date("2026-03-01T00:00:00Z")
    const newest = new Date("2026-06-01T00:00:00Z")
    p.approvalRequest.findMany.mockResolvedValue([
      { id: "a1", action: "users.delete", reason: "spam", requestedBy: "actor", resource: "user:u1", createdAt: oldest, expiresAt: new Date() },
    ])
    p.incident.findMany.mockResolvedValue([
      { id: "i1", title: "API down", severity: "sev1", status: "open", category: "api", startedAt: newest },
    ])
    p.anomalyEvent.findMany.mockResolvedValue([
      { id: "x1", kind: "vpn_login", ipAddress: null, userId: "u1", createdAt: middle },
    ])
    const { req, res, next, jsonMock } = ctx()
    await getInbox(req, res, next)
    const payload = jsonMock.mock.calls[0][0]
    expect(payload.items.length).toBe(3)
    expect(payload.items[0].kind).toBe("incident")     // newest
    expect(payload.items[2].kind).toBe("approval")     // oldest
    expect(payload.counters.byKind.incident).toBe(1)
  })

  it("classifies sev1 as critical, sev2 as warning", async () => {
    await setupEmpty()
    const p = ((await import("../app/src/config/prisma")) as unknown as { prisma: Record<string, Record<string, ReturnType<typeof vi.fn>>> }).prisma
    p.incident.findMany.mockResolvedValue([
      { id: "i1", title: "x", severity: "sev1", status: "open", category: "x", startedAt: new Date() },
      { id: "i2", title: "y", severity: "sev2", status: "open", category: "y", startedAt: new Date() },
    ])
    const { req, res, next, jsonMock } = ctx()
    await getInbox(req, res, next)
    const items = jsonMock.mock.calls[0][0].items
    expect(items.find((i: { id: string }) => i.id === "incident:i1").severity).toBe("critical")
    expect(items.find((i: { id: string }) => i.id === "incident:i2").severity).toBe("warning")
  })

  it("only surfaces webhooks with failCount > 2 (signal, not noise)", async () => {
    await setupEmpty()
    const p = ((await import("../app/src/config/prisma")) as unknown as { prisma: Record<string, Record<string, ReturnType<typeof vi.fn>>> }).prisma
    p.ticketWebhook.findMany.mockResolvedValue([
      { id: "w1", url: "https://x", lastDeliveryAt: new Date(), failCount: 5 },
    ])
    const { req, res, next, jsonMock } = ctx()
    await getInbox(req, res, next)
    expect(jsonMock.mock.calls[0][0].items.find((i: { id: string }) => i.id === "webhook:w1")).toBeDefined()
  })
})
