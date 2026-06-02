import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { flushSlaMetrics } from "../../middlewares/slaMetrics.middleware"

/**
 * Rolling RED-metric overview per endpoint. Powered by the in-process
 * slaMetrics middleware + flush job. Defaults to last 24h.
 */

export async function getSlaOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24))
    const since = new Date(Date.now() - hours * 60 * 60_000)

    // Group across hour buckets per endpoint
    const rows = await prisma.endpointStat.findMany({
      where:   { hourBucket: { gte: since } },
      orderBy: { hourBucket: "asc" },
    })

    interface Agg { endpoint: string; requests: number; errors: number; clientErrors: number; totalDurationMs: number; maxDurationMs: number; p50Ms: number; p99Ms: number; lastHour: Date }
    const byEndpoint = new Map<string, Agg>()
    for (const r of rows) {
      const a = byEndpoint.get(r.endpoint) ?? {
        endpoint: r.endpoint, requests: 0, errors: 0, clientErrors: 0,
        totalDurationMs: 0, maxDurationMs: 0, p50Ms: 0, p99Ms: 0, lastHour: r.hourBucket,
      }
      a.requests     += r.requests
      a.errors       += r.errors
      a.clientErrors += r.clientErrors
      a.totalDurationMs += Number(r.totalDurationMs)
      if (r.maxDurationMs > a.maxDurationMs) a.maxDurationMs = r.maxDurationMs
      if (r.p50Ms > a.p50Ms) a.p50Ms = r.p50Ms      // pick max p50 across buckets (conservative)
      if (r.p99Ms > a.p99Ms) a.p99Ms = r.p99Ms
      if (r.hourBucket > a.lastHour) a.lastHour = r.hourBucket
      byEndpoint.set(r.endpoint, a)
    }

    const endpoints = Array.from(byEndpoint.values())
      .map(a => ({
        endpoint:    a.endpoint,
        requests:    a.requests,
        errors:      a.errors,
        clientErrors:a.clientErrors,
        errorRatePct: a.requests > 0 ? +(a.errors / a.requests * 100).toFixed(2) : 0,
        meanMs:      a.requests > 0 ? Math.round(a.totalDurationMs / a.requests) : 0,
        p50Ms:       a.p50Ms,
        p99Ms:       a.p99Ms,
        maxMs:       a.maxDurationMs,
        lastHour:    a.lastHour,
      }))
      .sort((a, b) => b.requests - a.requests)

    // Hour-by-hour totals for the rollup chart
    const byHour = new Map<string, { hour: string; requests: number; errors: number }>()
    for (const r of rows) {
      const key = r.hourBucket.toISOString()
      const h = byHour.get(key) ?? { hour: key, requests: 0, errors: 0 }
      h.requests += r.requests
      h.errors   += r.errors
      byHour.set(key, h)
    }
    const series = Array.from(byHour.values()).sort((a, b) => a.hour.localeCompare(b.hour))

    res.status(200).json({ hours, endpoints, series })
  } catch (err) { next(err) }
}

/** Manual flush — primarily for tests + ops debugging. */
export async function flushSla(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const r = await flushSlaMetrics()
    res.status(200).json(r)
  } catch (err) { next(err) }
}
