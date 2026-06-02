import { describe, it, expect, vi, beforeEach } from "vitest"

const user = {
  id: "u1", isBanned: false, isShadowBanned: false,
  role: "USER", createdAt: new Date(Date.now() - 365 * 86_400_000),
}
let events: Array<{ type: string; ipAddress: string | null; createdAt: Date }> = []
let distinctIps: Array<{ ipAddress: string | null }> = []
let reportCount = 0
let currentUser: typeof user | null = user

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user:          { findUnique: vi.fn(async () => currentUser) },
    securityEvent: {
      findMany: vi.fn(async (args: { distinct?: string[] }) => args.distinct ? distinctIps : events),
    },
    report:        { count: vi.fn(async () => reportCount) },
    anomalyEvent:  { findMany: vi.fn(async () => []) },  // no anomalies — risk score from other signals only
  },
}))

import { computeUserRisk } from "../app/src/lib/riskScore"

beforeEach(() => {
  events = []; distinctIps = []; reportCount = 0
  currentUser = { ...user }
})

describe("riskScore", () => {
  it("returns low (0) for a clean account", async () => {
    const r = await computeUserRisk("u1")
    expect(r.score).toBe(0)
    expect(r.level).toBe("low")
    expect(r.signals).toEqual([])
  })

  it("returns critical when banned", async () => {
    currentUser = { ...user, isBanned: true }
    const r = await computeUserRisk("u1")
    expect(r.signals.find(s => s.code === "banned")).toBeDefined()
    expect(r.score).toBeGreaterThanOrEqual(40)
  })

  it("flags many failed logins in 24h", async () => {
    const now = new Date()
    for (let i = 0; i < 6; i++) events.push({ type: "login_failed", ipAddress: "1.1.1.1", createdAt: now })
    const r = await computeUserRisk("u1")
    expect(r.signals.find(s => s.code === "many_failed_24h")).toBeDefined()
  })

  it("scales level with combined signals", async () => {
    currentUser = { ...user, isBanned: true, isShadowBanned: true }
    reportCount = 5
    const r = await computeUserRisk("u1")
    expect(r.level).toBe("critical")
    expect(r.score).toBeGreaterThanOrEqual(70)
  })

  it("caps score at 100", async () => {
    currentUser = { ...user, isBanned: true, isShadowBanned: true }
    for (let i = 0; i < 20; i++) events.push({ type: "login_failed", ipAddress: "x", createdAt: new Date() })
    events.push({ type: "csrf_failure", ipAddress: "x", createdAt: new Date() })
    reportCount = 10
    distinctIps = Array(10).fill({ ipAddress: "x" })
    const r = await computeUserRisk("u1")
    expect(r.score).toBeLessThanOrEqual(100)
  })

  it("returns score=0 + low for unknown user (defensive)", async () => {
    currentUser = null
    const r = await computeUserRisk("missing")
    expect(r.score).toBe(0)
    expect(r.signals).toEqual([])
  })
})
