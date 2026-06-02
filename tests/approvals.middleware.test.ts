import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    approvalRequest: {
      findUnique: vi.fn(),
      create:     vi.fn(),
      update:     vi.fn(),
    },
  },
}))
vi.mock("../app/src/lib/adminAudit", () => ({
  adminAuditR: vi.fn(async () => undefined),
}))

import { requireApproval } from "../app/src/lib/approvals"

function ctx(opts: { actorId?: string; headerId?: string; body?: Record<string, unknown>; params?: Record<string, string> } = {}): { req: Request; res: Response; next: NextFunction; jsonMock: ReturnType<typeof vi.fn>; statusMock: ReturnType<typeof vi.fn> } {
  const jsonMock = vi.fn()
  const statusMock = vi.fn(function (this: Response) { return this })
  const res = {
    status: statusMock,
    json:   jsonMock,
    locals: { user: opts.actorId ? { id: opts.actorId } : undefined },
  } as unknown as Response
  const req = {
    body:   opts.body ?? {},
    params: opts.params ?? {},
    header: (n: string) => n === "X-Approval-Id" ? opts.headerId : undefined,
  } as unknown as Request
  return { req, res, next: vi.fn() as NextFunction, jsonMock, statusMock }
}

describe("requireApproval middleware", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("first leg: records a pending request and returns 202", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      approvalRequest: { create: ReturnType<typeof vi.fn> }
    }
    prisma.approvalRequest.create.mockResolvedValue({ id: "ar-1", expiresAt: new Date(Date.now() + 24*60*60_000) })
    const mw = requireApproval({ action: "users.delete", resource: (r) => `user:${r.params.userId}` })
    const { req, res, next, jsonMock, statusMock } = ctx({ actorId: "actor-1", params: { userId: "u-99" }, body: { _reason: "spam" } })
    await mw(req, res, next)
    expect(statusMock).toHaveBeenCalledWith(202)
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ approvalRequired: true, approvalId: "ar-1" }))
    expect(next).not.toHaveBeenCalled()
    expect(prisma.approvalRequest.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "users.delete", resource: "user:u-99", reason: "spam", requestedBy: "actor-1" }),
    }))
  })

  it("second leg: rejects when approval is not approved yet", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      approvalRequest: { findUnique: ReturnType<typeof vi.fn> }
    }
    prisma.approvalRequest.findUnique.mockResolvedValue({
      id: "ar-1", action: "users.delete", status: "pending",
      requestedBy: "actor-1", expiresAt: new Date(Date.now() + 60_000),
    })
    const mw = requireApproval({ action: "users.delete", resource: () => "user:u-99" })
    const { req, res, next } = ctx({ actorId: "actor-1", headerId: "ar-1" })
    await mw(req, res, next)
    expect(next).toHaveBeenCalled()
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(err.status).toBe(403)
  })

  it("second leg: rejects when actor != requester (executor binding)", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      approvalRequest: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
    }
    prisma.approvalRequest.findUnique.mockResolvedValue({
      id: "ar-1", action: "users.delete", status: "approved",
      requestedBy: "alice", expiresAt: new Date(Date.now() + 60_000),
    })
    const mw = requireApproval({ action: "users.delete", resource: () => "user:u-99" })
    const { req, res, next } = ctx({ actorId: "bob", headerId: "ar-1" })
    await mw(req, res, next)
    expect(next).toHaveBeenCalled()
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(err.status).toBe(403)
  })

  it("second leg: marks executed + allows handler when approved + actor matches", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      approvalRequest: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
    }
    prisma.approvalRequest.findUnique.mockResolvedValue({
      id: "ar-1", action: "users.delete", status: "approved",
      requestedBy: "alice", expiresAt: new Date(Date.now() + 60_000),
      resource: "user:u-99",
    })
    prisma.approvalRequest.update.mockResolvedValue({})
    const mw = requireApproval({ action: "users.delete", resource: () => "user:u-99" })
    const { req, res, next } = ctx({ actorId: "alice", headerId: "ar-1" })
    await mw(req, res, next)
    expect(next).toHaveBeenCalledWith()
    expect(prisma.approvalRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "executed" }),
    }))
  })

  it("rejects approval used for the wrong action", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      approvalRequest: { findUnique: ReturnType<typeof vi.fn> }
    }
    prisma.approvalRequest.findUnique.mockResolvedValue({
      id: "ar-1", action: "billing.refund", status: "approved",
      requestedBy: "alice", expiresAt: new Date(Date.now() + 60_000),
    })
    const mw = requireApproval({ action: "users.delete", resource: () => "user:u-99" })
    const { req, res, next } = ctx({ actorId: "alice", headerId: "ar-1" })
    await mw(req, res, next)
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(err.status).toBe(400)
  })
})
