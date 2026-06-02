import { describe, it, expect, vi, beforeEach } from "vitest"

interface SE { userId: string | null; ipAddress: string | null; createdAt: Date; type: string }
interface RT { userId: string; ipAddress: string | null; lastUsedAt: Date }

let securityEvents: SE[] = []
let refreshTokens:  RT[] = []
let ipProfiles = new Map<string, { country: string | null; latitude: number | null; longitude: number | null; isVpn: boolean; isHosting: boolean; isp: string | null; asn: string | null; city: string | null; countryName: string | null }>()
let anomalies: Array<{ kind: string; severity: string; userId: string | null; ipAddress: string | null; createdAt: Date }> = []
let createdAlerts: Array<{ severity: string; category: string; title: string }> = []

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    securityEvent: {
      findMany: vi.fn(async ({ where, distinct }: { where: Record<string, unknown>; distinct?: string[] }) => {
        let r = securityEvents.slice()
        if (where.type) r = r.filter(e => e.type === where.type)
        if ((where as { ipAddress?: { not: null } }).ipAddress?.not === null) r = r.filter(e => e.ipAddress !== null)
        if ((where as { userId?: { not: null } }).userId?.not === null)       r = r.filter(e => e.userId !== null)
        if (distinct?.includes("ipAddress")) {
          const seen = new Set()
          r = r.filter(e => { if (seen.has(e.ipAddress)) return false; seen.add(e.ipAddress); return true })
        }
        return r
      }),
    },
    refreshToken: {
      findMany: vi.fn(async () => refreshTokens),
    },
    ipProfile: {
      findUnique: vi.fn(async ({ where: { ip } }: { where: { ip: string } }) =>
        ipProfiles.has(ip) ? { ip, ...ipProfiles.get(ip), refreshedAt: new Date(), lastSeenAt: new Date(), region: null, org: null, lookupSource: "test", lookupError: null } : null),
      update:     vi.fn(async () => undefined),
      upsert:     vi.fn(async () => undefined),
    },
    anomalyEvent: {
      findFirst: vi.fn(async ({ where }: { where: { kind: string; userId: string | null; ipAddress: string | null; createdAt: { gte: Date } } }) =>
        anomalies.find(a =>
          a.kind === where.kind &&
          a.userId === where.userId &&
          a.ipAddress === where.ipAddress &&
          a.createdAt >= where.createdAt.gte
        ) ?? null),
      create: vi.fn(async ({ data }: { data: { kind: string; severity: string; userId: string | null; ipAddress: string | null } }) => {
        anomalies.push({ ...data, createdAt: new Date() }); return data
      }),
      count: vi.fn(async () => anomalies.length),
      groupBy: vi.fn(async () => []),
    },
    adminAlert: {
      create: vi.fn(async ({ data }: { data: { severity: string; category: string; title: string } }) => {
        createdAlerts.push(data); return data
      }),
    },
  },
}))

import { runAnomalyScan } from "../app/src/lib/anomalyDetector"

beforeEach(() => {
  securityEvents = []
  refreshTokens  = []
  ipProfiles     = new Map()
  anomalies      = []
  createdAlerts  = []
})

describe("anomalyDetector", () => {
  it("detects impossible travel between two cities in < 1 hour", async () => {
    const now = new Date()
    securityEvents.push({ type: "login_success", userId: "u1", ipAddress: "ip-ny", createdAt: new Date(now.getTime() - 30 * 60_000) })
    securityEvents.push({ type: "login_success", userId: "u1", ipAddress: "ip-tk", createdAt: now })
    ipProfiles.set("ip-ny", { country: "US", latitude: 40.7128, longitude: -74.006, isVpn: false, isHosting: false, isp: "Verizon", asn: "AS701", city: "New York", countryName: "United States" })
    ipProfiles.set("ip-tk", { country: "JP", latitude: 35.6762, longitude: 139.6503, isVpn: false, isHosting: false, isp: "NTT", asn: "AS4713", city: "Tokyo", countryName: "Japan" })
    await runAnomalyScan()
    expect(anomalies.find(a => a.kind === "impossible_travel" && a.userId === "u1")).toBeDefined()
    expect(createdAlerts.find(a => a.title.includes("impossible"))).toBeDefined()  // critical → also alert
  })

  it("does NOT flag impossible travel within same city", async () => {
    const now = new Date()
    securityEvents.push({ type: "login_success", userId: "u1", ipAddress: "ip-1", createdAt: new Date(now.getTime() - 30 * 60_000) })
    securityEvents.push({ type: "login_success", userId: "u1", ipAddress: "ip-2", createdAt: now })
    ipProfiles.set("ip-1", { country: "US", latitude: 40.7128, longitude: -74.006, isVpn: false, isHosting: false, isp: "x", asn: "x", city: "NYC", countryName: "US" })
    ipProfiles.set("ip-2", { country: "US", latitude: 40.7140, longitude: -74.005, isVpn: false, isHosting: false, isp: "x", asn: "x", city: "NYC", countryName: "US" })
    await runAnomalyScan()
    expect(anomalies.find(a => a.kind === "impossible_travel")).toBeUndefined()
  })

  it("flags VPN/datacenter login (warning severity)", async () => {
    securityEvents.push({ type: "login_success", userId: "u1", ipAddress: "ip-vpn", createdAt: new Date() })
    ipProfiles.set("ip-vpn", { country: "US", latitude: 0, longitude: 0, isVpn: true, isHosting: false, isp: "NordVPN", asn: "AS-VPN", city: null, countryName: "US" })
    await runAnomalyScan()
    expect(anomalies.find(a => a.kind === "vpn_login")).toBeDefined()
  })

  it("flags high-volume signup IP (5+ accounts in 24h)", async () => {
    const now = new Date()
    for (let i = 0; i < 6; i++) {
      securityEvents.push({ type: "register", userId: `u${i}`, ipAddress: "ip-spam", createdAt: now })
    }
    await runAnomalyScan()
    expect(anomalies.find(a => a.kind === "high_volume_signup_ip" && a.ipAddress === "ip-spam")).toBeDefined()
  })

  it("does NOT flag a single signup from an IP", async () => {
    securityEvents.push({ type: "register", userId: "u1", ipAddress: "ip", createdAt: new Date() })
    await runAnomalyScan()
    expect(anomalies.find(a => a.kind === "high_volume_signup_ip")).toBeUndefined()
  })

  it("flags concurrent country sessions within 10 min", async () => {
    const now = new Date()
    refreshTokens.push({ userId: "u1", ipAddress: "ip-us", lastUsedAt: new Date(now.getTime() - 5 * 60_000) })
    refreshTokens.push({ userId: "u1", ipAddress: "ip-jp", lastUsedAt: now })
    ipProfiles.set("ip-us", { country: "US", latitude: 0, longitude: 0, isVpn: false, isHosting: false, isp: null, asn: null, city: null, countryName: null })
    ipProfiles.set("ip-jp", { country: "JP", latitude: 0, longitude: 0, isVpn: false, isHosting: false, isp: null, asn: null, city: null, countryName: null })
    await runAnomalyScan()
    expect(anomalies.find(a => a.kind === "concurrent_country")).toBeDefined()
  })

  it("returns aggregate counts", async () => {
    const r = await runAnomalyScan()
    expect(r).toHaveProperty("detected")
    expect(r).toHaveProperty("byKind")
  })
})
