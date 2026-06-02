import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    llmCall:       { findMany: vi.fn() },
    promptVersion: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    evalResult:    { findMany: vi.fn(), create: vi.fn() },
    ragDocument:   { findMany: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    $transaction:  vi.fn(async (ops: unknown[]) => ops),
  },
}))
vi.mock("../app/src/lib/adminAudit", () => ({ adminAuditR: vi.fn(async () => undefined) }))

import * as ctrl from "../app/src/modules/admin/aiOps.controller"

function ctx(body: Record<string, unknown> = {}, params: Record<string, string> = {}, query: Record<string, string> = {}): { req: Request; res: Response; next: NextFunction; jsonMock: ReturnType<typeof vi.fn> } {
  const jsonMock = vi.fn()
  const res = { status: vi.fn().mockReturnThis(), json: jsonMock, locals: { user: { id: "actor" } } } as unknown as Response
  return { req: { body, params, query } as unknown as Request, res, next: vi.fn() as NextFunction, jsonMock }
}

describe("aiOps — llm overview", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("aggregates by model + endpoint and converts cost units to dollars", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      llmCall: { findMany: ReturnType<typeof vi.fn> }
    }
    prisma.llmCall.findMany.mockResolvedValue([
      { model: "gpt-4o-mini", endpoint: "/ai/x", costCents: 500, totalTokens: 1000, latencyMs: 100, status: "ok",    createdAt: new Date() },
      { model: "gpt-4o-mini", endpoint: "/ai/x", costCents: 200, totalTokens: 400,  latencyMs: 200, status: "ok",    createdAt: new Date() },
      { model: "claude",      endpoint: "/ai/y", costCents: 800, totalTokens: 800,  latencyMs: 300, status: "error", createdAt: new Date() },
    ])
    const { req, res, next, jsonMock } = ctx()
    await ctrl.getLlmOverview(req, res, next)
    const p = jsonMock.mock.calls[0][0]
    expect(p.totals.calls).toBe(3)
    expect(p.totals.errors).toBe(1)
    expect(p.totals.errorRatePct).toBeCloseTo(33.33, 1)
    expect(p.totals.costDollars).toBeCloseTo(0.15, 4)         // 1500 units = $0.15 with CENTS_PER_DOLLAR=10000
    expect(p.byModel.find((m: { key: string }) => m.key === "gpt-4o-mini").calls).toBe(2)
  })
})

describe("aiOps — prompt registry", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("createPromptVersion increments version per key", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      promptVersion: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
    }
    prisma.promptVersion.findFirst.mockResolvedValue({ version: 5 })
    prisma.promptVersion.create.mockResolvedValue({ id: "pv1", key: "x", version: 6 })
    const { req, res, next } = ctx({ key: "x", template: "y" })
    await ctrl.createPromptVersion(req, res, next)
    expect(prisma.promptVersion.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ version: 6 }) }))
  })

  it("activatePromptVersion deactivates siblings via transaction", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      promptVersion: { findUnique: ReturnType<typeof vi.fn> }
      $transaction: ReturnType<typeof vi.fn>
    }
    prisma.promptVersion.findUnique.mockResolvedValue({ id: "pv1", key: "x", version: 3 })
    const { req, res, next } = ctx({}, { id: "pv1" })
    await ctrl.activatePromptVersion(req, res, next)
    expect(prisma.$transaction).toHaveBeenCalled()
  })
})

describe("aiOps — rag", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("listRag aggregates summary per collection", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      ragDocument: { findMany: ReturnType<typeof vi.fn> }
    }
    prisma.ragDocument.findMany.mockResolvedValue([
      { collection: "anime_facts", chunks: 10, bytes: 1000 },
      { collection: "anime_facts", chunks: 5,  bytes: 500 },
      { collection: "help",        chunks: 3,  bytes: 300 },
    ])
    const { req, res, next, jsonMock } = ctx()
    await ctrl.listRag(req, res, next)
    const p = jsonMock.mock.calls[0][0]
    expect(p.summary.find((s: { collection: string }) => s.collection === "anime_facts")).toEqual({ collection: "anime_facts", docs: 2, chunks: 15, bytes: 1500 })
  })

  it("upsertRag rejects missing contentHash", async () => {
    const { req, res, next } = ctx({ collection: "x", title: "y" })
    await ctrl.upsertRag(req, res, next)
    expect((next as ReturnType<typeof vi.fn>).mock.calls[0][0].status).toBe(400)
  })
})
