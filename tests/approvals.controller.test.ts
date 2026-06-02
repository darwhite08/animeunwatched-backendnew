import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    approvalRequest: {
      findUnique: vi.fn(),
      findMany:   vi.fn(),
      update:     vi.fn(),
    },
    approvalDecision: { create: vi.fn() },
  },
}))
vi.mock("../app/src/lib/adminAudit", () => ({ adminAuditR: vi.fn(async () => undefined) }))

import * as ctrl from "../app/src/modules/admin/approvals.controller"

function ctx(body: Record<string, unknown> = {}, params: Record<string, string> = {}): { req: Request; res: Response; next: NextFunction } {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), locals: { user: { id: "reviewer-1" } } } as unknown as Response
  return { req: { body, params, query: {} } as unknown as Request, res, next: vi.fn() as NextFunction }
}

describe("approvals.controller.reviewApproval", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("rejects self-approval (two-person rule)", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      approvalRequest: { findUnique: ReturnType<typeof vi.fn> }
    }
    prisma.approvalRequest.findUnique.mockResolvedValue({
      id: "ar-1", action: "users.delete", status: "pending",
      requestedBy: "reviewer-1", expiresAt: new Date(Date.now() + 60_000),
    })
    const { req, res, next } = ctx({ decision: "approve" }, { id: "ar-1" })
    await ctrl.reviewApproval(req, res, next)
    expect(next).toHaveBeenCalled()
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(err.status).toBe(403)
    expect(err.message).toMatch(/two-person/i)
  })

  it("approves a pending request from a different actor", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      approvalRequest: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
      approvalDecision: { create: ReturnType<typeof vi.fn> }
    }
    prisma.approvalRequest.findUnique.mockResolvedValue({
      id: "ar-1", action: "users.delete", status: "pending",
      requestedBy: "alice", expiresAt: new Date(Date.now() + 60_000),
      resource: "user:u-99",
    })
    prisma.approvalRequest.update.mockResolvedValue({ id: "ar-1", status: "approved" })
    prisma.approvalDecision.create.mockResolvedValue({})
    const { req, res, next } = ctx({ decision: "approve", note: "ok" }, { id: "ar-1" })
    await ctrl.reviewApproval(req, res, next)
    expect(prisma.approvalDecision.create).toHaveBeenCalled()
    expect(prisma.approvalRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "approved", reviewedBy: "reviewer-1" }),
    }))
  })

  it("rejects with invalid decision string", async () => {
    const { req, res, next } = ctx({ decision: "maybe" }, { id: "ar-1" })
    await ctrl.reviewApproval(req, res, next)
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(err.status).toBe(400)
  })
})
