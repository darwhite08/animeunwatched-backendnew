import { prisma } from "../config/prisma"
import { getIpProfile, haversineKm, refreshIpProfile } from "./geoip"

/**
 * Anomaly detection. Scans recent SecurityEvent rows + IpProfile cache
 * to flag suspicious patterns. Designed to be run periodically (every
 * 5 min) by the anomalyScan job; can also be called inline after a
 * successful login for instant-detection paths.
 *
 * Each detected anomaly is upserted into AnomalyEvent. Critical-severity
 * ones additionally raise an AdminAlert so they surface on the overview
 * "attention" panel.
 *
 * The detector is intentionally conservative — false positives cost mod
 * attention. Thresholds tuned for medium-scale platforms; expose them as
 * env vars when scale demands it.
 */

// Speed > 1000 km/h between two logins = "impossible travel" (commercial
// flights cap ~900 km/h). Tunable — anyone within 1h on different
// continents triggers it.
const IMPOSSIBLE_TRAVEL_KMH = 1000

// "New X" lookbacks: how far back to scan when deciding if a value is "first-seen"
const NEW_LOOKBACK_DAYS = 90

interface CreateAnomalyInput {
  kind:      string
  severity:  "info" | "warning" | "critical"
  userId?:   string | null
  ipAddress?: string | null
  evidence?: Record<string, unknown>
}

async function createAnomaly(a: CreateAnomalyInput): Promise<void> {
  // De-dupe: don't write the same kind for the same user+ip within the last hour.
  const oneHourAgo = new Date(Date.now() - 60 * 60_000)
  const existing = await prisma.anomalyEvent.findFirst({
    where: {
      kind: a.kind,
      userId: a.userId ?? null,
      ipAddress: a.ipAddress ?? null,
      createdAt: { gte: oneHourAgo },
    },
  })
  if (existing) return

  await prisma.anomalyEvent.create({
    data: {
      kind: a.kind,
      severity: a.severity,
      userId: a.userId ?? null,
      ipAddress: a.ipAddress ?? null,
      evidence: (a.evidence ?? null) as never,
    },
  })

  if (a.severity === "critical") {
    await prisma.adminAlert.create({
      data: {
        severity: "critical",
        category: "security",
        title:    `Security anomaly: ${a.kind.replace(/_/g, " ")}`,
        body:     a.userId ? `User ${a.userId}` + (a.ipAddress ? ` from IP ${a.ipAddress}` : "") : a.ipAddress ?? null,
        link:     a.userId ? `/users/${a.userId}` : a.ipAddress ? `/inspect/ip/${a.ipAddress}` : "/anomalies",
        metadata: { kind: a.kind, ...(a.evidence ?? {}) } as never,
      },
    })
  }
}

// ── Impossible travel ──────────────────────────────────────────────────────
async function detectImpossibleTravel(): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60_000)
  const logins = await prisma.securityEvent.findMany({
    where:   { type: "login_success", userId: { not: null }, ipAddress: { not: null }, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select:  { userId: true, ipAddress: true, createdAt: true },
  })

  // Group by user → ordered list of (ip, time)
  const byUser = new Map<string, Array<{ ip: string; at: Date }>>()
  for (const ev of logins) {
    if (!ev.userId || !ev.ipAddress) continue
    const arr = byUser.get(ev.userId) ?? []
    arr.push({ ip: ev.ipAddress, at: ev.createdAt })
    byUser.set(ev.userId, arr)
  }

  for (const [userId, events] of byUser) {
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1], cur = events[i]
      if (prev.ip === cur.ip) continue
      const [prevGeo, curGeo] = await Promise.all([getIpProfile(prev.ip), getIpProfile(cur.ip)])
      if (!prevGeo?.latitude || !prevGeo?.longitude || !curGeo?.latitude || !curGeo?.longitude) continue
      const distKm = haversineKm(
        { lat: prevGeo.latitude, lon: prevGeo.longitude },
        { lat: curGeo.latitude,  lon: curGeo.longitude  },
      )
      const hours = (cur.at.getTime() - prev.at.getTime()) / 3_600_000
      if (hours <= 0) continue
      const kmh = distKm / hours
      if (kmh < IMPOSSIBLE_TRAVEL_KMH) continue
      await createAnomaly({
        kind: "impossible_travel", severity: "critical",
        userId, ipAddress: cur.ip,
        evidence: {
          fromIp: prev.ip, fromCountry: prevGeo.country, fromCity: prevGeo.city,
          toIp:   cur.ip,  toCountry:   curGeo.country,  toCity:   curGeo.city,
          distKm: Math.round(distKm), hours: hours.toFixed(2), kmh: Math.round(kmh),
        },
      })
    }
  }
}

// ── New country for a user ────────────────────────────────────────────────
async function detectNewCountry(): Promise<void> {
  const since1h    = new Date(Date.now() - 60 * 60_000)
  const sinceWindow = new Date(Date.now() - NEW_LOOKBACK_DAYS * 86_400_000)

  const recent = await prisma.securityEvent.findMany({
    where:  { type: "login_success", createdAt: { gte: since1h }, userId: { not: null }, ipAddress: { not: null } },
    select: { userId: true, ipAddress: true },
  })

  for (const ev of recent) {
    if (!ev.userId || !ev.ipAddress) continue
    const geo = await getIpProfile(ev.ipAddress)
    if (!geo?.country) continue
    // Has this user EVER logged in from this country before this hour?
    const historicalIps = await prisma.securityEvent.findMany({
      where:   { userId: ev.userId, type: "login_success", ipAddress: { not: null }, createdAt: { gte: sinceWindow, lt: since1h } },
      select:  { ipAddress: true },
      distinct: ["ipAddress"],
    })
    let knownCountry = false
    for (const r of historicalIps) {
      if (!r.ipAddress) continue
      const g = await getIpProfile(r.ipAddress)
      if (g?.country === geo.country) { knownCountry = true; break }
    }
    if (knownCountry) continue
    await createAnomaly({
      kind: "new_country", severity: historicalIps.length > 0 ? "warning" : "info",
      userId: ev.userId, ipAddress: ev.ipAddress,
      evidence: { country: geo.country, countryName: geo.countryName, city: geo.city, isVpn: geo.isVpn, isHosting: geo.isHosting },
    })
  }
}

// ── VPN/datacenter login on otherwise residential account ─────────────────
async function detectVpnLogin(): Promise<void> {
  const since = new Date(Date.now() - 60 * 60_000)
  const events = await prisma.securityEvent.findMany({
    where:  { type: "login_success", createdAt: { gte: since }, userId: { not: null }, ipAddress: { not: null } },
    select: { userId: true, ipAddress: true },
  })
  for (const ev of events) {
    if (!ev.userId || !ev.ipAddress) continue
    const geo = await getIpProfile(ev.ipAddress)
    if (!geo) continue
    if (!geo.isVpn && !geo.isHosting) continue
    await createAnomaly({
      kind: "vpn_login", severity: "warning",
      userId: ev.userId, ipAddress: ev.ipAddress,
      evidence: { isp: geo.isp, asn: geo.asn, isVpn: geo.isVpn, isHosting: geo.isHosting, country: geo.country },
    })
  }
}

// ── IP churn: many distinct accounts from one IP in a short window ───────
async function detectIpChurn(): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60_000)
  // Group registration events by IP
  const regs = await prisma.securityEvent.findMany({
    where:  { type: "register", createdAt: { gte: since }, ipAddress: { not: null } },
    select: { userId: true, ipAddress: true },
  })
  const byIp = new Map<string, Set<string>>()
  for (const r of regs) {
    if (!r.ipAddress || !r.userId) continue
    const s = byIp.get(r.ipAddress) ?? new Set<string>()
    s.add(r.userId)
    byIp.set(r.ipAddress, s)
  }
  for (const [ip, users] of byIp) {
    if (users.size < 5) continue
    await createAnomaly({
      kind: "high_volume_signup_ip", severity: users.size >= 10 ? "critical" : "warning",
      ipAddress: ip,
      evidence: { accountsCreated24h: users.size, userIds: Array.from(users).slice(0, 20) },
    })
  }
}

// ── Concurrent sessions in different countries ────────────────────────────
async function detectConcurrentCountry(): Promise<void> {
  // Recent active refresh tokens grouped by user
  const tokens = await prisma.refreshToken.findMany({
    where:   { expiresAt: { gt: new Date() }, ipAddress: { not: null } },
    select:  { userId: true, ipAddress: true, lastUsedAt: true },
  })
  const byUser = new Map<string, Array<{ ip: string; lastUsed: Date }>>()
  for (const t of tokens) {
    if (!t.ipAddress) continue
    const arr = byUser.get(t.userId) ?? []
    arr.push({ ip: t.ipAddress, lastUsed: t.lastUsedAt })
    byUser.set(t.userId, arr)
  }
  const TEN_MIN = 10 * 60_000
  for (const [userId, sessions] of byUser) {
    if (sessions.length < 2) continue
    // Find any pair within 10 min on different countries
    const enriched: Array<{ ip: string; country: string | null; lastUsed: Date }> = []
    for (const s of sessions) {
      const geo = await getIpProfile(s.ip)
      enriched.push({ ip: s.ip, country: geo?.country ?? null, lastUsed: s.lastUsed })
    }
    enriched.sort((a, b) => a.lastUsed.getTime() - b.lastUsed.getTime())
    for (let i = 1; i < enriched.length; i++) {
      const prev = enriched[i - 1], cur = enriched[i]
      if (!prev.country || !cur.country || prev.country === cur.country) continue
      if (cur.lastUsed.getTime() - prev.lastUsed.getTime() > TEN_MIN) continue
      await createAnomaly({
        kind: "concurrent_country", severity: "warning",
        userId,
        evidence: { ip1: prev.ip, c1: prev.country, ip2: cur.ip, c2: cur.country, gapSec: Math.round((cur.lastUsed.getTime() - prev.lastUsed.getTime()) / 1000) },
      })
      break  // one anomaly per user per scan is enough
    }
  }
}

// ── Mark all referenced IPs as recently seen + refresh stale profiles ────
async function refreshIpsTouchedRecently(): Promise<void> {
  const since = new Date(Date.now() - 15 * 60_000)
  const events = await prisma.securityEvent.findMany({
    where:    { createdAt: { gte: since }, ipAddress: { not: null } },
    select:   { ipAddress: true },
    distinct: ["ipAddress"],
    take:     200,
  })
  const ips = events.map(e => e.ipAddress).filter((x): x is string => !!x)
  for (const ip of ips) {
    const row = await prisma.ipProfile.findUnique({ where: { ip } })
    if (!row) { void refreshIpProfile(ip) }  // fire-and-forget for fresh ones
    else await prisma.ipProfile.update({ where: { ip }, data: { lastSeenAt: new Date() } })
  }
}

export interface AnomalyScanResult {
  detected: number
  byKind:   Record<string, number>
}

/** Top-level entry: runs every detector. Returns rollup counts. */
export async function runAnomalyScan(): Promise<AnomalyScanResult> {
  const before = await prisma.anomalyEvent.count()
  await refreshIpsTouchedRecently()
  await detectImpossibleTravel()
  await detectNewCountry()
  await detectVpnLogin()
  await detectIpChurn()
  await detectConcurrentCountry()
  const after = await prisma.anomalyEvent.count()
  const byKind: Record<string, number> = {}
  if (after > before) {
    const since = new Date(Date.now() - 10 * 60_000)
    const recent = await prisma.anomalyEvent.groupBy({
      by: ["kind"], where: { createdAt: { gte: since } }, _count: { _all: true },
    })
    for (const r of recent) byKind[r.kind] = r._count._all
  }
  return { detected: after - before, byKind }
}
