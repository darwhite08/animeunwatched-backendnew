import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    oauthClient: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    oauthAccessToken: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}))
vi.mock("../app/src/lib/adminAudit", () => ({ adminAuditR: vi.fn(async () => undefined) }))

import * as ctrl from "../app/src/modules/admin/oauthClients.controller"

function ctx(body: Record<string, unknown> = {}, params: Record<string, string> = {}): { req: Request; res: Response; next: NextFunction; jsonMock: ReturnType<typeof vi.fn> } {
  const jsonMock = vi.fn()
  const res = { status: vi.fn().mockReturnThis(), json: jsonMock, locals: { user: { id: "actor" } } } as unknown as Response
  return { req: { body, params, query: {} } as unknown as Request, res, next: vi.fn() as NextFunction, jsonMock }
}

describe("oauthClients.controller", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("createClient returns plaintext secret ONCE + persists hash", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      oauthClient: { create: ReturnType<typeof vi.fn> }
    }
    prisma.oauthClient.create.mockResolvedValue({ id: "c1", name: "Zapier", clientId: "ka_oc_x", scopes: ["scim"], clientSecretHash: "h", createdAt: new Date() })
    const { req, res, next, jsonMock } = ctx({ name: "Zapier", scopes: ["scim"] })
    await ctrl.createClient(req, res, next)
    const payload = jsonMock.mock.calls[0][0]
    expect(payload.clientSecret).toMatch(/^ka_sk_/)
    expect(payload.client.clientSecretHash).toBeUndefined()    // never returned
    expect(payload._warning).toMatch(/not be shown/i)
    expect(prisma.oauthClient.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: "Zapier", scopes: ["scim"] }),
    }))
  })

  it("createClient rejects unknown scope", async () => {
    const { req, res, next } = ctx({ name: "x", scopes: ["write:literally_anything"] })
    await ctrl.createClient(req, res, next)
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(err.status).toBe(400)
    expect(err.message).toMatch(/Unknown scope/)
  })

  it("revokeClient also invalidates all access tokens", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      oauthClient: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
      oauthAccessToken: { updateMany: ReturnType<typeof vi.fn> }
    }
    prisma.oauthClient.findUnique.mockResolvedValue({ id: "c1", name: "x", revokedAt: null })
    prisma.oauthClient.update.mockResolvedValue({})
    prisma.oauthAccessToken.updateMany.mockResolvedValue({ count: 3 })
    const { req, res, next } = ctx({}, { id: "c1" })
    await ctrl.revokeClient(req, res, next)
    expect(prisma.oauthAccessToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: "c1", revokedAt: null } }),
    )
  })

  it("listClients strips clientSecretHash from response", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      oauthClient: { findMany: ReturnType<typeof vi.fn> }
    }
    prisma.oauthClient.findMany.mockResolvedValue([
      { id: "c1", name: "x", clientId: "ka_oc_x", clientSecretHash: "DO_NOT_LEAK", scopes: [] },
    ])
    const { req, res, next, jsonMock } = ctx()
    await ctrl.listClients(req, res, next)
    const payload = jsonMock.mock.calls[0][0]
    expect(payload.data[0].clientSecretHash).toBeUndefined()
    expect(JSON.stringify(payload)).not.toContain("DO_NOT_LEAK")
  })
})
