import { describe, it, expect, vi, beforeEach } from "vitest"

let policySettings: Record<string, unknown> = {}
let users:   Array<{ id: string; email: string }> = []
let ipBlocks: Array<{ ip: string; reason: string; expiresAt: Date }> = []
let failCount = 0
let totp: { userId: string; enabled: boolean } | null = null

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    adminSetting: {
      findUnique: vi.fn(async ({ where: { key } }: { where: { key: string } }) =>
        key in policySettings ? { value: policySettings[key] } : null),
    },
    user: {
      findUnique: vi.fn(async ({ where: { email } }: { where: { email: string } }) =>
        users.find(u => u.email === email) ?? null),
    },
    securityEvent: {
      count: vi.fn(async () => failCount),
    },
    ipBlock: {
      findUnique: vi.fn(async ({ where: { ip } }: { where: { ip: string } }) =>
        ipBlocks.find(b => b.ip === ip) ?? null),
      upsert: vi.fn(async ({ create }: { create: { ip: string; reason: string; expiresAt: Date } }) => {
        ipBlocks.push(create); return create
      }),
    },
    totpSecret: {
      findUnique: vi.fn(async ({ where: { userId } }: { where: { userId: string } }) =>
        totp?.userId === userId ? totp : null),
    },
  },
}))

import { preLoginChecks, postPasswordChecks, maybeBlockBruteIp, isIpBlocked } from "../app/src/lib/loginGuard"

beforeEach(() => {
  policySettings = {}; users = []; ipBlocks = []; failCount = 0; totp = null
  users.push({ id: "u1", email: "x@y" })
})

describe("loginGuard.preLoginChecks", () => {
  it("returns null when nothing is wrong", async () => {
    expect(await preLoginChecks({ email: "x@y", ip: "1.1.1.1" })).toBeNull()
  })

  it("blocks IP that's in IpBlock and not expired", async () => {
    ipBlocks.push({ ip: "1.1.1.1", reason: "bruteforce", expiresAt: new Date(Date.now() + 60_000) })
    const r = await preLoginChecks({ email: "x@y", ip: "1.1.1.1" })
    expect(r).toMatch(/IP.*blocked/)
  })

  it("expired IpBlock does NOT block", async () => {
    ipBlocks.push({ ip: "1.1.1.1", reason: "bruteforce", expiresAt: new Date(Date.now() - 1000) })
    expect(await preLoginChecks({ email: "x@y", ip: "1.1.1.1" })).toBeNull()
  })

  it("enforces ipAllowList when configured", async () => {
    policySettings["security.ipAllowList"] = ["10.0.0.1"]
    expect(await preLoginChecks({ email: "x@y", ip: "1.1.1.1" })).toMatch(/allow-list/)
    expect(await preLoginChecks({ email: "x@y", ip: "10.0.0.1" })).toBeNull()
  })

  it("empty allowlist is no-op", async () => {
    policySettings["security.ipAllowList"] = []
    expect(await preLoginChecks({ email: "x@y", ip: "1.1.1.1" })).toBeNull()
  })

  it("locks out account after 5 failed attempts in window", async () => {
    failCount = 5
    expect(await preLoginChecks({ email: "x@y", ip: "1.1.1.1" })).toMatch(/locked/)
  })

  it("permits login at threshold-1 fails", async () => {
    failCount = 4
    expect(await preLoginChecks({ email: "x@y", ip: "1.1.1.1" })).toBeNull()
  })
})

describe("loginGuard.postPasswordChecks", () => {
  it("ok when MFA not required", async () => {
    expect(await postPasswordChecks("u1")).toBe("ok")
  })

  it("mfa_required when policy says yes and user has no TOTP", async () => {
    policySettings["security.mfaRequired"] = true
    expect(await postPasswordChecks("u1")).toBe("mfa_required")
  })

  it("ok when policy says yes and user has enrolled TOTP", async () => {
    policySettings["security.mfaRequired"] = true
    totp = { userId: "u1", enabled: true }
    expect(await postPasswordChecks("u1")).toBe("ok")
  })

  it("mfa_required when TOTP exists but is disabled (mid-enrollment)", async () => {
    policySettings["security.mfaRequired"] = true
    totp = { userId: "u1", enabled: false }
    expect(await postPasswordChecks("u1")).toBe("mfa_required")
  })
})

describe("loginGuard.maybeBlockBruteIp", () => {
  it("no-op when ip is null", async () => {
    await expect(maybeBlockBruteIp(null)).resolves.toBeUndefined()
    expect(ipBlocks).toHaveLength(0)
  })

  it("does not block below threshold", async () => {
    failCount = 29
    await maybeBlockBruteIp("1.1.1.1")
    expect(ipBlocks).toHaveLength(0)
  })

  it("blocks IP at brute-force threshold", async () => {
    failCount = 30
    await maybeBlockBruteIp("1.1.1.1")
    expect(ipBlocks.find(b => b.ip === "1.1.1.1" && b.reason === "bruteforce")).toBeDefined()
  })
})

describe("loginGuard.isIpBlocked", () => {
  it("returns blocked=true for active block", async () => {
    ipBlocks.push({ ip: "1.1.1.1", reason: "manual", expiresAt: new Date(Date.now() + 60_000) })
    const r = await isIpBlocked("1.1.1.1")
    expect(r.blocked).toBe(true)
    expect(r.reason).toBe("manual")
  })

  it("returns blocked=false for expired block", async () => {
    ipBlocks.push({ ip: "1.1.1.1", reason: "manual", expiresAt: new Date(Date.now() - 1000) })
    expect((await isIpBlocked("1.1.1.1")).blocked).toBe(false)
  })

  it("returns blocked=false for unknown ip", async () => {
    expect((await isIpBlocked("9.9.9.9")).blocked).toBe(false)
  })
})
