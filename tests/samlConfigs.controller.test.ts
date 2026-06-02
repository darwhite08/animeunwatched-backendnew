import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Request, Response, NextFunction } from "express"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    samlConfig: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    samlLoginEvent: { findMany: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  },
}))
vi.mock("../app/src/lib/adminAudit", () => ({ adminAuditR: vi.fn(async () => undefined) }))
vi.mock("../app/src/lib/saml", () => ({ invalidateSamlCache: vi.fn() }))

import * as ctrl from "../app/src/modules/admin/samlConfigs.controller"

function ctx(body: Record<string, unknown> = {}, params: Record<string, string> = {}): { req: Request; res: Response; next: NextFunction; jsonMock: ReturnType<typeof vi.fn> } {
  const jsonMock = vi.fn()
  const res = { status: vi.fn().mockReturnThis(), json: jsonMock, locals: { user: { id: "actor" } } } as unknown as Response
  return { req: { body, params, query: {}, header: () => undefined } as unknown as Request, res, next: vi.fn() as NextFunction, jsonMock }
}

describe("samlConfigs.controller", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("createConfig requires name + idpEntityId + idpSsoUrl + idpCertificate + spEntityId", async () => {
    const { req, res, next } = ctx({ name: "x" })
    await ctrl.createConfig(req, res, next)
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(err.status).toBe(400)
  })

  it("createConfig persists with defaults applied", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      samlConfig: { create: ReturnType<typeof vi.fn> }
    }
    prisma.samlConfig.create.mockResolvedValue({ id: "c1", name: "Okta", spPrivateKey: null })
    const { req, res, next } = ctx({
      name: "Okta", idpEntityId: "urn:okta", idpSsoUrl: "https://x", idpCertificate: "MIIB", spEntityId: "https://sp",
    })
    await ctrl.createConfig(req, res, next)
    expect(prisma.samlConfig.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ emailAttribute: "email", displayNameAttr: "displayName", autoProvision: true }),
    }))
  })

  it("listConfigs never returns spPrivateKey or full certificate", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      samlConfig: { findMany: ReturnType<typeof vi.fn> }
    }
    prisma.samlConfig.findMany.mockResolvedValue([
      { id: "c1", name: "x", spPrivateKey: "SECRET_KEY", idpCertificate: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----", spCertificate: null },
    ])
    const { req, res, next, jsonMock } = ctx()
    await ctrl.listConfigs(req, res, next)
    const payload = jsonMock.mock.calls[0][0]
    expect(payload.data[0].spPrivateKey).toBeUndefined()
    expect(payload.data[0].idpCertificate).toBeUndefined()
    expect(payload.data[0].hasSpPrivateKey).toBe(true)
    expect(payload.data[0].idpCertificateFingerprint).toMatch(/^[0-9a-f:]+$/)
    expect(JSON.stringify(payload)).not.toContain("SECRET_KEY")
  })

  it("activateConfig deactivates others atomically", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      samlConfig: { findUnique: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
      $transaction: ReturnType<typeof vi.fn>
    }
    prisma.samlConfig.findUnique.mockResolvedValue({ id: "c1", name: "Okta" })
    const { req, res, next } = ctx({}, { id: "c1" })
    await ctrl.activateConfig(req, res, next)
    expect(prisma.$transaction).toHaveBeenCalled()
  })
})
