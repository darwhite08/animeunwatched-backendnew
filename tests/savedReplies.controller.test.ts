import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    savedReply: {
      findMany:   vi.fn(),
      findUnique: vi.fn(),
      create:     vi.fn(),
      update:     vi.fn(),
      delete:     vi.fn(),
    },
  },
}))
vi.mock("../app/src/lib/adminAudit", () => ({ adminAuditR: vi.fn(async () => undefined) }))

import * as ctrl from "../app/src/modules/admin/savedReplies.controller"

function ctx(body: Record<string, unknown> = {}, params: Record<string, string> = {}, query: Record<string, string> = {}): { req: Request; res: Response; next: NextFunction } {
  const res = {
    status:  vi.fn().mockReturnThis(),
    json:    vi.fn(),
    locals: { user: { id: "u-1" } },
  } as unknown as Response
  return { req: { body, params, query } as unknown as Request, res, next: vi.fn() as NextFunction }
}

describe("savedReplies.controller", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("createReply rejects duplicate shortcut", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      savedReply: { findUnique: ReturnType<typeof vi.fn> }
    }
    prisma.savedReply.findUnique.mockResolvedValue({ id: "r-1" })
    const { req, res, next } = ctx({ title: "t", body: "b", shortcut: "/spam" })
    await ctrl.createReply(req, res, next)
    expect(next).toHaveBeenCalled()
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(err.status).toBe(400)
    expect(err.message).toMatch(/shortcut/i)
  })

  it("listReplies filters by category", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      savedReply: { findMany: ReturnType<typeof vi.fn> }
    }
    prisma.savedReply.findMany.mockResolvedValue([])
    const { req, res, next } = ctx({}, {}, { category: "spam" })
    await ctrl.listReplies(req, res, next)
    expect(prisma.savedReply.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { category: "spam" } }),
    )
  })

  it("markUsed bumps useCount", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      savedReply: { update: ReturnType<typeof vi.fn> }
    }
    prisma.savedReply.update.mockResolvedValue({})
    const { req, res, next } = ctx({}, { id: "r-1" })
    await ctrl.markUsed(req, res, next)
    expect(prisma.savedReply.update).toHaveBeenCalledWith({ where: { id: "r-1" }, data: { useCount: { increment: 1 } } })
  })
})
