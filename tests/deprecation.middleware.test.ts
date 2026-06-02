import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => ({
  prisma: { deprecatedEndpoint: { findMany: vi.fn() } },
}))

import { deprecationHeaders, invalidateDeprecationCache } from "../app/src/middlewares/deprecation.middleware"

function ctx(method: string, path: string, route?: string): { req: Request; res: Response; next: NextFunction; setHeaderMock: ReturnType<typeof vi.fn> } {
  const setHeaderMock = vi.fn()
  const res = { setHeader: setHeaderMock } as unknown as Response
  const req = { method, path, baseUrl: "", route: route ? { path: route } : undefined } as Request
  return { req, res, next: vi.fn() as NextFunction, setHeaderMock }
}

describe("deprecationHeaders middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invalidateDeprecationCache()
  })

  it("emits Sunset + Deprecation for matched endpoint", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      deprecatedEndpoint: { findMany: ReturnType<typeof vi.fn> }
    }
    prisma.deprecatedEndpoint.findMany.mockResolvedValue([
      { endpoint: "GET /old", sunsetAt: new Date("2099-01-01"), reason: null, replacement: "/new" },
    ])
    const { req, res, next, setHeaderMock } = ctx("GET", "/old", "/old")
    await deprecationHeaders()(req, res, next)
    expect(setHeaderMock).toHaveBeenCalledWith("Sunset", expect.stringMatching(/2099/))
    expect(setHeaderMock).toHaveBeenCalledWith("Deprecation", "true")
    expect(setHeaderMock).toHaveBeenCalledWith("Link", expect.stringContaining("/new"))
    expect(next).toHaveBeenCalled()
  })

  it("emits nothing when no match", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      deprecatedEndpoint: { findMany: ReturnType<typeof vi.fn> }
    }
    prisma.deprecatedEndpoint.findMany.mockResolvedValue([])
    const { req, res, next, setHeaderMock } = ctx("GET", "/fresh", "/fresh")
    await deprecationHeaders()(req, res, next)
    expect(setHeaderMock).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalled()
  })

  it("never blocks even when prisma errors", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      deprecatedEndpoint: { findMany: ReturnType<typeof vi.fn> }
    }
    prisma.deprecatedEndpoint.findMany.mockRejectedValue(new Error("boom"))
    const { req, res, next } = ctx("GET", "/x", "/x")
    await deprecationHeaders()(req, res, next)
    expect(next).toHaveBeenCalled()
  })
})
