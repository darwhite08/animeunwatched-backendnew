import { prisma } from "../../config/prisma"
import { readSecret } from "../vault"

/**
 * Datadog metric forwarder. On each EndpointStat flush, post per-endpoint
 * counters to Datadog as gauges. Reads the API key from Vault — vendor
 * credentials never appear in env or DB plaintext.
 *
 * Wired from the Integration framework: when an admin creates an
 * Integration row with provider="datadog", this connector activates.
 */

const DATADOG_API_HOST = process.env.DATADOG_API_HOST ?? "https://api.datadoghq.com"

interface DatadogConfig {
  region?:    string             // "us" | "eu" — adjusts the api host
  metricPrefix?: string          // default: "kaiveron"
  apiKeyOverride?: string        // dev-only fallback if vault not used
}

export async function pushDatadogMetrics(): Promise<{ sent: number; skipped: number }> {
  const integration = await prisma.integration.findFirst({ where: { provider: "datadog", active: true } })
  if (!integration) return { sent: 0, skipped: 0 }
  const cfg = (integration.configJson ?? {}) as DatadogConfig
  const apiKey = integration.secretName ? await readSecret(integration.secretName) : cfg.apiKeyOverride ?? null
  if (!apiKey) {
    await markFail(integration.id, "no API key — set secretName referring to a Vault entry")
    return { sent: 0, skipped: 0 }
  }
  const host = cfg.region === "eu" ? "https://api.datadoghq.eu" : DATADOG_API_HOST
  const prefix = cfg.metricPrefix ?? "kaiveron"

  // Roll up the last hour of EndpointStat into Datadog points
  const since = new Date(Date.now() - 60 * 60_000)
  const stats = await prisma.endpointStat.findMany({ where: { hourBucket: { gte: since } } })
  if (stats.length === 0) {
    await prisma.integration.update({ where: { id: integration.id }, data: { lastSyncAt: new Date(), lastSyncStatus: "ok" } })
    return { sent: 0, skipped: 0 }
  }
  const now = Math.floor(Date.now() / 1000)
  const series = stats.flatMap(s => [
    { metric: `${prefix}.requests`,  type: "count", points: [[Math.floor(s.hourBucket.getTime() / 1000), s.requests]],   tags: [`endpoint:${s.endpoint}`] },
    { metric: `${prefix}.errors`,    type: "count", points: [[Math.floor(s.hourBucket.getTime() / 1000), s.errors]],     tags: [`endpoint:${s.endpoint}`] },
    { metric: `${prefix}.latency.p50`, type: "gauge", points: [[now, s.p50Ms]], tags: [`endpoint:${s.endpoint}`] },
    { metric: `${prefix}.latency.p99`, type: "gauge", points: [[now, s.p99Ms]], tags: [`endpoint:${s.endpoint}`] },
  ])

  try {
    const r = await fetch(`${host}/api/v1/series`, {
      method: "POST",
      headers: {
        "DD-API-KEY":    apiKey,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({ series }),
    })
    if (!r.ok) throw new Error(`Datadog returned ${r.status}: ${await r.text().catch(() => "")}`)
    await prisma.integration.update({
      where: { id: integration.id },
      data:  { lastSyncAt: new Date(), lastSyncStatus: "ok", lastError: null },
    })
    return { sent: series.length, skipped: 0 }
  } catch (err) {
    await markFail(integration.id, (err as Error).message)
    return { sent: 0, skipped: series.length }
  }
}

async function markFail(id: string, detail: string): Promise<void> {
  await prisma.integration.update({
    where: { id }, data: { lastSyncAt: new Date(), lastSyncStatus: "fail", lastError: detail.slice(0, 500) },
  }).catch(() => undefined)
}
