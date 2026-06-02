/**
 * Google Analytics 4 — server-side realtime API client.
 *
 * Activated by setting these env vars:
 *   GA_PROPERTY_ID            - numeric GA4 property id (e.g. 499123456)
 *   GA_SERVICE_ACCOUNT_JSON   - the full service-account JSON, base64'd OR raw
 *                               with newlines escaped. Easiest: paste raw JSON.
 *
 * Without both set, every helper returns `null` and the admin tile falls
 * back to our first-party tracker.
 */
import { BetaAnalyticsDataClient } from "@google-analytics/data"

const PROPERTY_ID = process.env.GA_PROPERTY_ID
const SA_RAW      = process.env.GA_SERVICE_ACCOUNT_JSON

export interface GA4RealtimeSnapshot {
  activeUsers:    number   // users active in the last 30 min
  views30m:       number   // page_view events in the last 30 min (best-effort)
  topPages:       Array<{ path: string; users: number }>
  topCountries:   Array<{ country: string; users: number }>
  generatedAt:    number
}

let cached: BetaAnalyticsDataClient | null = null
let configError: string | null = null

function getClient(): BetaAnalyticsDataClient | null {
  if (cached) return cached
  if (configError) return null
  if (!PROPERTY_ID || !SA_RAW) {
    configError = "GA_PROPERTY_ID or GA_SERVICE_ACCOUNT_JSON not set"
    return null
  }
  try {
    // Accept either raw JSON or base64-encoded JSON. Base64 avoids
    // the newline-in-env-var pain on App Runner.
    let jsonText = SA_RAW.trim()
    if (!jsonText.startsWith("{")) {
      jsonText = Buffer.from(jsonText, "base64").toString("utf8")
    }
    const credentials = JSON.parse(jsonText) as { client_email: string; private_key: string }
    cached = new BetaAnalyticsDataClient({ credentials })
    return cached
  } catch (err) {
    configError = `Failed to parse GA_SERVICE_ACCOUNT_JSON: ${(err as Error).message}`
    console.error("[ga4]", configError)
    return null
  }
}

export function isGA4Configured(): boolean {
  return !!PROPERTY_ID && !!SA_RAW
}

/**
 * Pull the GA4 realtime snapshot. Returns null when:
 *   - GA4 isn't configured (so the admin tile keeps the placeholder)
 *   - the API call fails (logged, never thrown)
 */
export async function getGA4Realtime(): Promise<GA4RealtimeSnapshot | null> {
  const client = getClient()
  if (!client) return null

  const property = `properties/${PROPERTY_ID}`
  try {
    // Active users (last 30 min). minutesAgo=29 → today.
    const [activeRes] = await client.runRealtimeReport({
      property,
      metrics: [{ name: "activeUsers" }, { name: "screenPageViews" }],
    })
    const activeUsers = Number(activeRes.rows?.[0]?.metricValues?.[0]?.value ?? 0)
    const views30m    = Number(activeRes.rows?.[0]?.metricValues?.[1]?.value ?? 0)

    // Top pages by active users in the last 30 min
    const [pageRes] = await client.runRealtimeReport({
      property,
      dimensions: [{ name: "unifiedScreenName" }],
      metrics:    [{ name: "activeUsers" }],
      orderBys:   [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit:      5,
    })
    const topPages = (pageRes.rows ?? []).map((r) => ({
      path:  (r.dimensionValues?.[0]?.value ?? "(unknown)").slice(0, 80),
      users: Number(r.metricValues?.[0]?.value ?? 0),
    }))

    // Top countries
    const [countryRes] = await client.runRealtimeReport({
      property,
      dimensions: [{ name: "country" }],
      metrics:    [{ name: "activeUsers" }],
      orderBys:   [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit:      5,
    })
    const topCountries = (countryRes.rows ?? []).map((r) => ({
      country: r.dimensionValues?.[0]?.value ?? "(unknown)",
      users:   Number(r.metricValues?.[0]?.value ?? 0),
    }))

    return {
      activeUsers,
      views30m,
      topPages,
      topCountries,
      generatedAt: Date.now(),
    }
  } catch (err) {
    console.error("[ga4] realtime report failed:", (err as Error).message)
    return null
  }
}
