import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    consentRecord:  { findMany: vi.fn() },
    rtbfRequest:    { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    vendorRecord:   { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    kmsKeyRotation: { findMany: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  },
}))
vi.mock("../app/src/lib/adminAudit", () => ({ adminAuditR: vi.fn(async () => undefined) }))

import * as ctrl from "../app/src/modules/admin/compliance.controller"

function ctx(body: Record<string, unknown> = {}, params: Record<string, string> = {}, query: Record<string, string> = {}): { req: Request; res: Response; next: NextFunction; jsonMock: ReturnType<typeof vi.fn> } {
  const jsonMock = vi.fn()
  const res = { status: vi.fn().mockReturnThis(), json: jsonMock, locals: { user: { id: "actor" } } } as unknown as Response
  return { req: { body, params, query } as unknown as Request, res, next: vi.fn() as NextFunction, jsonMock }
}

describe("compliance — consent", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("groups counters by purpose with given/withdrawn", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      consentRecord: { findMany: ReturnType<typeof vi.fn> }
    }
    prisma.consentRecord.findMany.mockResolvedValue([
      { purpose: "marketing_email", withdrawnAt: null },
      { purpose: "marketing_email", withdrawnAt: null },
      { purpose: "marketing_email", withdrawnAt: new Date() },
      { purpose: "ai_training",     withdrawnAt: null },
    ])
    const { req, res, next, jsonMock } = ctx()
    await ctrl.listConsent(req, res, next)
    const p = jsonMock.mock.calls[0][0]
    expect(p.counters.marketing_email).toEqual({ given: 2, withdrawn: 1 })
    expect(p.counters.ai_training).toEqual({ given: 1, withdrawn: 0 })
  })
})

describe("compliance — RTBF", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("createRtbf returns plaintext verification token + persists hash", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      rtbfRequest: { create: ReturnType<typeof vi.fn> }
    }
    prisma.rtbfRequest.create.mockResolvedValue({ id: "r1" })
    const { req, res, next, jsonMock } = ctx({ userId: "u1", email: "x@y.com" })
    await ctrl.createRtbf(req, res, next)
    const p = jsonMock.mock.calls[0][0]
    expect(p.verificationToken).toMatch(/^[a-f0-9]{64}$/)
    expect(p._warning).toMatch(/not be shown again/i)
    const data = prisma.rtbfRequest.create.mock.calls[0][0].data
    expect(data.verificationTokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(data.verificationTokenHash).not.toBe(p.verificationToken)
  })

  it("reviewRtbf rejects invalid status", async () => {
    const { req, res, next } = ctx({ status: "weird" }, { id: "r1" })
    await ctrl.reviewRtbf(req, res, next)
    expect((next as ReturnType<typeof vi.fn>).mock.calls[0][0].status).toBe(400)
  })

  it("reviewRtbf=completed sets executedAt + executorId", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      rtbfRequest: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
    }
    prisma.rtbfRequest.findUnique.mockResolvedValue({ id: "r1", userId: "u1", email: "x@y.com" })
    prisma.rtbfRequest.update.mockResolvedValue({ id: "r1", status: "completed" })
    const { req, res, next } = ctx({ status: "completed" }, { id: "r1" })
    await ctrl.reviewRtbf(req, res, next)
    expect(prisma.rtbfRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "completed", executedAt: expect.any(Date), executorId: "actor" }),
    }))
  })
})

describe("compliance — vendors + KMS", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("upsertVendor rejects missing url", async () => {
    const { req, res, next } = ctx({ name: "x", category: "ai_model" })
    await ctrl.upsertVendor(req, res, next)
    expect((next as ReturnType<typeof vi.fn>).mock.calls[0][0].status).toBe(400)
  })

  it("listKms surfaces overdue count", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      kmsKeyRotation: { findMany: ReturnType<typeof vi.fn> }
    }
    prisma.kmsKeyRotation.findMany.mockResolvedValue([
      { keyAlias: "a", nextDueAt: new Date(Date.now() - 86400_000) },     // overdue
      { keyAlias: "b", nextDueAt: new Date(Date.now() + 86400_000) },
    ])
    const { req, res, next, jsonMock } = ctx()
    await ctrl.listKms(req, res, next)
    expect(jsonMock.mock.calls[0][0].overdue).toBe(1)
  })
})
