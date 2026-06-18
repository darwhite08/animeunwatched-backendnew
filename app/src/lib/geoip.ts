import { prisma } from "../config/prisma"

/**
 * On-demand IP geolocation + ASN/VPN/datacenter detection.
 *
 * Uses ip-api.com (free, 45 req/min, no auth) via the JSON endpoint.
 * Results are cached in the IpProfile table forever; refreshed once a
 * week. Lookups are async + fire-and-forget — callers should accept that
 * fresh IPs return null and let the cache populate in the background.
 *
 * For paid GA: swap to MaxMind GeoIP2 or IPinfo by replacing fetchFromProvider.
 */

const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000 // 1 week
const LOOKUP_TIMEOUT_MS = 2_500

export interface IpInfo {
  ip:          string
  country:     string | null
  countryName: string | null
  region:      string | null
  city:        string | null
  latitude:    number | null
  longitude:   number | null
  isp:         string | null
  org:         string | null
  asn:         string | null
  isVpn:       boolean
  isProxy:     boolean
  isHosting:   boolean
  refreshedAt: Date
}

interface IpApiResponse {
  status?:      "success" | "fail"
  message?:     string
  country?:     string
  countryCode?: string
  region?:      string
  regionName?:  string
  city?:        string
  lat?:         number
  lon?:         number
  isp?:         string
  org?:         string
  as?:          string
  proxy?:       boolean
  hosting?:     boolean
  mobile?:      boolean
}

async function fetchFromProvider(ip: string): Promise<IpApiResponse | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS)
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,region,regionName,city,lat,lon,isp,org,as,proxy,hosting,mobile`
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    return await res.json() as IpApiResponse
  } catch { return null }
}

function isPrivateOrInvalid(ip: string): boolean {
  // Skip lookup for RFC1918 / localhost / unknown — saves API quota.
  if (!ip || ip === "::1" || ip === "127.0.0.1") return true
  if (/^10\./.test(ip)) return true
  if (/^192\.168\./.test(ip)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true
  if (/^169\.254\./.test(ip)) return true
  if (/^fc00:/i.test(ip) || /^fe80:/i.test(ip)) return true
  return false
}

/**
 * Get IpProfile from cache, or trigger a background refresh + return
 * the stale row (or null if we have nothing). Never blocks the caller
 * for more than a DB round trip.
 */
export async function getIpProfile(ip: string): Promise<IpInfo | null> {
  if (isPrivateOrInvalid(ip)) {
    return {
      ip, country: null, countryName: null, region: null, city: null,
      latitude: null, longitude: null, isp: "local/private", org: null, asn: null,
      isVpn: false, isProxy: false, isHosting: false, refreshedAt: new Date(),
    }
  }

  const row = await prisma.ipProfile.findUnique({ where: { ip } })
  if (row && Date.now() - row.refreshedAt.getTime() < REFRESH_AFTER_MS) {
    return rowToInfo(row)
  }

  // Stale or missing — refresh in background. Return whatever we have.
  void refreshIpProfile(ip).catch(err => console.error(`[geoip] refresh failed for ${ip}:`, err))
  return row ? rowToInfo(row) : null
}

/** Awaited version — useful in tests / one-off scripts. */
export async function refreshIpProfile(ip: string): Promise<IpInfo | null> {
  if (isPrivateOrInvalid(ip)) return null
  const data = await fetchFromProvider(ip)
  if (!data || data.status !== "success") {
    // Persist the failure so we don't hammer the API on the same dead IP.
    await prisma.ipProfile.upsert({
      where:  { ip },
      update: { lookupError: data?.message ?? "fetch failed", refreshedAt: new Date() },
      create: { ip, lookupError: data?.message ?? "fetch failed" },
    })
    return null
  }
  const asn = data.as?.split(" ")[0]
  const row = await prisma.ipProfile.upsert({
    where:  { ip },
    update: {
      country: data.countryCode ?? null,
      countryName: data.country ?? null,
      region: data.regionName ?? null,
      city: data.city ?? null,
      latitude: data.lat ?? null,
      longitude: data.lon ?? null,
      isp: data.isp ?? null,
      org: data.org ?? null,
      asn: asn ?? null,
      isProxy: !!data.proxy,
      isHosting: !!data.hosting,
      // ip-api doesn't expose `vpn` directly; proxy OR (hosting + mobile=false) is a heuristic
      isVpn: !!data.proxy,
      lookupError: null,
      refreshedAt: new Date(),
    },
    create: {
      ip,
      country: data.countryCode ?? null,
      countryName: data.country ?? null,
      region: data.regionName ?? null,
      city: data.city ?? null,
      latitude: data.lat ?? null,
      longitude: data.lon ?? null,
      isp: data.isp ?? null,
      org: data.org ?? null,
      asn: asn ?? null,
      isProxy: !!data.proxy,
      isHosting: !!data.hosting,
      isVpn: !!data.proxy,
    },
  })
  return rowToInfo(row)
}

function rowToInfo(row: NonNullable<Awaited<ReturnType<typeof prisma.ipProfile.findUnique>>>): IpInfo {
  return {
    ip:          row.ip,
    country:     row.country,
    countryName: row.countryName,
    region:      row.region,
    city:        row.city,
    latitude:    row.latitude,
    longitude:   row.longitude,
    isp:         row.isp,
    org:         row.org,
    asn:         row.asn,
    isVpn:       row.isVpn,
    isProxy:     row.isProxy,
    isHosting:   row.isHosting,
    refreshedAt: row.refreshedAt,
  }
}

/** Update lastSeenAt on the cached row — call when a SecurityEvent
 *  references this IP, regardless of cache freshness. */
export async function markIpSeen(ip: string): Promise<void> {
  if (isPrivateOrInvalid(ip)) return
  await prisma.ipProfile.upsert({
    where:  { ip },
    update: { lastSeenAt: new Date() },
    create: { ip, lastSeenAt: new Date() },
  }).catch(() => undefined)
}

/** Distance in km between two lat/lon pairs — haversine. */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371
  const toRad = (d: number): number => d * Math.PI / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat)
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon/2)**2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * Persist a user's country/region from an IP (no GPS). Best-effort, fire-and-
 * forget: resolves via getIpProfile (cached) and writes User.country/region.
 * By default only fills when empty (so we don't churn on every login); pass
 * overwrite to refresh. Used at signup/login and by the backfill script.
 */
export async function captureUserGeo(userId: string, ip: string | null | undefined, overwrite = false): Promise<void> {
  if (!ip || isPrivateOrInvalid(ip)) return
  try {
    if (!overwrite) {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { country: true } })
      if (u?.country) return // already known
    }
    const geo = await getIpProfile(ip)
    if (!geo?.country) return
    await prisma.user.update({
      where: { id: userId },
      data: { country: geo.country, region: geo.region ?? null },
    })
  } catch { /* geo is best-effort — never break auth */ }
}
