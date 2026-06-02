import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    piiField: {
      findUnique: vi.fn(),
      create:     vi.fn(),
    },
  },
}))

import { seedPiiInventory, PII_SEED } from "../app/src/lib/piiScanner"

describe("piiScanner", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("inserts a row for each missing field", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      piiField: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
    }
    prisma.piiField.findUnique.mockResolvedValue(null)
    prisma.piiField.create.mockResolvedValue({})
    const r = await seedPiiInventory()
    expect(r.added).toBe(PII_SEED.length)
    expect(r.existing).toBe(0)
    expect(prisma.piiField.create).toHaveBeenCalledTimes(PII_SEED.length)
  })

  it("is idempotent — skips rows that already exist", async () => {
    const prisma = (await import("../app/src/config/prisma")).prisma as unknown as {
      piiField: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
    }
    prisma.piiField.findUnique.mockResolvedValue({ id: "exists" })
    const r = await seedPiiInventory()
    expect(r.added).toBe(0)
    expect(r.existing).toBe(PII_SEED.length)
    expect(prisma.piiField.create).not.toHaveBeenCalled()
  })

  it("the seed catalogue covers User.email, RefreshToken.ipAddress, AuditLog.actorIp", () => {
    const has = (m: string, f: string) => PII_SEED.some(s => s.model === m && s.field === f)
    expect(has("User", "email")).toBe(true)
    expect(has("RefreshToken", "ipAddress")).toBe(true)
    expect(has("AuditLog", "actorIp")).toBe(true)
  })

  it("every seed entry has a valid classification + legalBasis", () => {
    const validClass = ["identifier", "contact", "sensitive", "behavioral", "device"]
    const validBasis = ["consent", "contract", "legitimate_interest", "legal_obligation"]
    for (const s of PII_SEED) {
      expect(validClass).toContain(s.classification)
      expect(validBasis).toContain(s.legalBasis)
    }
  })
})
