import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    oauthAccessToken: { findUnique: vi.fn(), update: vi.fn() },
  },
}))

import { requireOauth } from "../app/src/middlewares/oauth.middleware"

function ctx(authHeader: string | undefined): { req: Request; res: Response; next: NextFunction; statusMock: ReturnType<typeof vi.fn>; jsonMock: ReturnType<typeof vi.fn>; setHeaderMock: ReturnType<typeof vi.fn> } {
  const statusMock = vi.fn(function (this: Response) { return this })
  const jsonMock   = vi.fn()
  const setHeaderMock = vi.fn()
  const res = {
    status: statusMock,
    json:   jsonMock,
    setHeader: setHeaderMock,
    locals: {},
  } as unknown as Response
  const req = { header: (n: string) => n === "Authorization" ? authHeader : undefined } as unknown as Request
  return { req, res, next: vi.fn() as NextFunction, statusMock, jsonMock, setHeaderMock }
}

describe("requireOauth", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("rejects missing Authorization with 401 + WWW-Authenticate", async () => {
    const { req, res, next, statusMock, setHeaderMock } = ctx(undefined)
    await requireOauth()(req, res, next)
    expect(statusMock).toHaveBeenCalledWith(401)
    expect(setHeaderMock).toHaveBeenCalledWith("WWW-Authenticate", expect.stringMatching(/Bearer/))
    expect(next).not.toHaveBeenCalled()
  })

  it("rejects malformed Authorization", async () => {
    const { req, res, next, statusMock } = ctx("Token abc")
    await requireOauth()(req, res, next)
    expect(statusMock).toHaveBeenCalledWith(401)
  })

  it("rejects invalid token with 401", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      oauthAccessToken: { findUnique: ReturnType<typeof vi.fn> }
    }
    prisma.oauthAccessToken.findUnique.mockResolvedValue(null)
    const { req, res, next, statusMock } = ctx("Bearer ka_at_nope")
    await requireOauth()(req, res, next)
    expect(statusMock).toHaveBeenCalledWith(401)
  })

  it("rejects with 403 + insufficient_scope when scope missing", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      oauthAccessToken: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
    }
    prisma.oauthAccessToken.findUnique.mockResolvedValue({
      id: "t1", clientId: "c1", scopes: ["read:users"],
      expiresAt: new Date(Date.now() + 60_000), revokedAt: null,
      client: { id: "c1", name: "x", clientId: "ka_oc_x", revokedAt: null },
    })
    prisma.oauthAccessToken.update.mockResolvedValue({})
    const { req, res, next, statusMock, setHeaderMock } = ctx("Bearer ka_at_x")
    await requireOauth({ scope: "scim" })(req, res, next)
    expect(statusMock).toHaveBeenCalledWith(403)
    expect(setHeaderMock).toHaveBeenCalledWith("WWW-Authenticate", expect.stringMatching(/insufficient_scope/))
  })

  it("calls next() and sets res.locals.oauth when token + scope are valid", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      oauthAccessToken: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
    }
    prisma.oauthAccessToken.findUnique.mockResolvedValue({
      id: "t1", clientId: "c1", scopes: ["scim","read:users"],
      expiresAt: new Date(Date.now() + 60_000), revokedAt: null,
      client: { id: "c1", name: "Zapier", clientId: "ka_oc_x", revokedAt: null },
    })
    prisma.oauthAccessToken.update.mockResolvedValue({})
    const { req, res, next } = ctx("Bearer ka_at_x")
    await requireOauth({ scope: "scim" })(req, res, next)
    expect(next).toHaveBeenCalledWith()
    const oauth = (res.locals as { oauth: { client: { name: string } } }).oauth
    expect(oauth.client.name).toBe("Zapier")
  })
})
