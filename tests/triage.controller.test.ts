import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user:            { findUnique: vi.fn(), findMany: vi.fn() },
    refreshToken:    { findMany: vi.fn() },
    auditLog:        { findMany: vi.fn() },
    post:            { findMany: vi.fn() },
    postComment:     { findMany: vi.fn() },
    anomalyEvent:    { findMany: vi.fn() },
    userNote:        { findMany: vi.fn() },
  },
}))

import { getUserTriage } from "../app/src/modules/admin/triage.controller"

function ctx(userId: string): { req: Request; res: Response; next: NextFunction; jsonMock: ReturnType<typeof vi.fn> } {
  const jsonMock = vi.fn()
  const res = { status: vi.fn().mockReturnThis(), json: jsonMock, locals: {} } as unknown as Response
  return { req: { params: { userId } } as unknown as Request, res, next: vi.fn() as NextFunction, jsonMock }
}

describe("triage.getUserTriage", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("404s when user not found", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as { user: { findUnique: ReturnType<typeof vi.fn> } }
    prisma.user.findUnique.mockResolvedValue(null)
    const { req, res, next } = ctx("nope")
    await getUserTriage(req, res, next)
    expect((next as ReturnType<typeof vi.fn>).mock.calls[0][0].status).toBe(404)
  })

  it("returns full payload + risk score for a clean account", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      user: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> }
      refreshToken: { findMany: ReturnType<typeof vi.fn> }
      auditLog: { findMany: ReturnType<typeof vi.fn> }
      post: { findMany: ReturnType<typeof vi.fn> }
      postComment: { findMany: ReturnType<typeof vi.fn> }
      anomalyEvent: { findMany: ReturnType<typeof vi.fn> }
      userNote: { findMany: ReturnType<typeof vi.fn> }
    }
    prisma.user.findUnique.mockResolvedValue({
      id: "u1", email: "a@x.com", username: "alice", displayName: "Alice", role: "USER",
      isBanned: false, isShadowBanned: false, bannedReason: null, reputation: 0,
      createdAt: new Date(Date.now() - 365 * 24 * 60 * 60_000),  // 1y old account
    })
    prisma.refreshToken.findMany.mockResolvedValueOnce([])    // no recent IPs
                                  .mockResolvedValueOnce([])   // no active sessions
    prisma.user.findMany.mockResolvedValue([])
    prisma.auditLog.findMany.mockResolvedValue([])
    prisma.post.findMany.mockResolvedValue([])
    prisma.postComment.findMany.mockResolvedValue([])
    prisma.anomalyEvent.findMany.mockResolvedValue([])
    prisma.userNote.findMany.mockResolvedValue([])

    const { req, res, next, jsonMock } = ctx("u1")
    await getUserTriage(req, res, next)
    const p = jsonMock.mock.calls[0][0]
    expect(p.user.username).toBe("alice")
    expect(p.riskScore).toBe(0)             // no signals + old account
    expect(p.similarAccounts).toEqual([])
    expect(p.ipsSeen).toEqual([])
  })

  it("escalates risk score when banned IP-siblings + new account + anomalies pile up", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      user: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> }
      refreshToken: { findMany: ReturnType<typeof vi.fn> }
      auditLog: { findMany: ReturnType<typeof vi.fn> }
      post: { findMany: ReturnType<typeof vi.fn> }
      postComment: { findMany: ReturnType<typeof vi.fn> }
      anomalyEvent: { findMany: ReturnType<typeof vi.fn> }
      userNote: { findMany: ReturnType<typeof vi.fn> }
    }
    prisma.user.findUnique.mockResolvedValue({
      id: "u1", email: "spammer@x.com", username: "spammer", displayName: "Spammer", role: "USER",
      isBanned: false, isShadowBanned: false, bannedReason: null, reputation: 0,
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60_000),   // 2 days old → +15
    })
    prisma.refreshToken.findMany
      .mockResolvedValueOnce([
        { ipAddress: "1.2.3.4", userAgent: "x", createdAt: new Date() },
      ])
      .mockResolvedValueOnce([
        { userId: "sibling-1", ipAddress: "1.2.3.4", createdAt: new Date() },
        { userId: "sibling-2", ipAddress: "1.2.3.4", createdAt: new Date() },
      ])
      .mockResolvedValueOnce([])
    prisma.user.findMany.mockResolvedValue([
      { id: "sibling-1", username: "alt1", displayName: "Alt 1", isBanned: true },
      { id: "sibling-2", username: "alt2", displayName: "Alt 2", isBanned: false },
    ])
    prisma.auditLog.findMany.mockResolvedValue([])
    prisma.post.findMany.mockResolvedValue([])
    prisma.postComment.findMany.mockResolvedValue([])
    prisma.anomalyEvent.findMany.mockResolvedValue([
      { id: "a1", kind: "vpn_login", severity: "warning", ipAddress: "1.2.3.4", acknowledgedAt: null, createdAt: new Date(), evidence: {} },
      { id: "a2", kind: "impossible_travel", severity: "critical", ipAddress: "1.2.3.4", acknowledgedAt: null, createdAt: new Date(), evidence: {} },
    ])
    prisma.userNote.findMany.mockResolvedValue([])

    const { req, res, next, jsonMock } = ctx("u1")
    await getUserTriage(req, res, next)
    const p = jsonMock.mock.calls[0][0]
    // 2 anomalies × 8 = 16; 1 banned sibling × 20 = 20; 2 similar × 3 = 6; new account = 15 → 57
    expect(p.riskScore).toBeGreaterThanOrEqual(50)
    expect(p.similarAccounts.length).toBe(2)
    // Banned siblings should be first
    expect(p.similarAccounts[0].isBanned).toBe(true)
  })

  it("caps risk score at 100 even with absurd signal pile-up", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      user: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> }
      refreshToken: { findMany: ReturnType<typeof vi.fn> }
      auditLog: { findMany: ReturnType<typeof vi.fn> }
      post: { findMany: ReturnType<typeof vi.fn> }
      postComment: { findMany: ReturnType<typeof vi.fn> }
      anomalyEvent: { findMany: ReturnType<typeof vi.fn> }
      userNote: { findMany: ReturnType<typeof vi.fn> }
    }
    prisma.user.findUnique.mockResolvedValue({ id: "u1", email: "x", username: "x", displayName: "x", role: "USER", isBanned: false, isShadowBanned: false, bannedReason: null, reputation: 0, createdAt: new Date() })
    prisma.refreshToken.findMany.mockResolvedValueOnce([{ ipAddress: "1.1.1.1", userAgent: "x", createdAt: new Date() }])
                                 .mockResolvedValueOnce(Array.from({ length: 30 }, (_, i) => ({ userId: `s${i}`, ipAddress: "1.1.1.1", createdAt: new Date() })))
                                 .mockResolvedValueOnce([])
    prisma.user.findMany.mockResolvedValue(Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, username: `s${i}`, displayName: `s${i}`, isBanned: true })))
    prisma.auditLog.findMany.mockResolvedValue([])
    prisma.post.findMany.mockResolvedValue([])
    prisma.postComment.findMany.mockResolvedValue([])
    prisma.anomalyEvent.findMany.mockResolvedValue(Array.from({ length: 10 }, () => ({ id: "x", kind: "y", severity: "critical", ipAddress: null, acknowledgedAt: null, createdAt: new Date(), evidence: {} })))
    prisma.userNote.findMany.mockResolvedValue([])

    const { req, res, next, jsonMock } = ctx("u1")
    await getUserTriage(req, res, next)
    expect(jsonMock.mock.calls[0][0].riskScore).toBe(100)
  })
})
