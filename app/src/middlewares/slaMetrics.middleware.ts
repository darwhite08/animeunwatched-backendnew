import type { Request, Response, NextFunction } from "express"
import { prisma } from "../config/prisma"

/**
 * RED-metrics middleware: records request rate, error rate, and duration
 * percentiles per endpoint. Aggregated in-process into hourly buckets and
 * flushed to EndpointStat every minute (or sooner when a bucket flips
 * over the hour boundary).
 *
 * Cheap on the request path — only an end-of-response hook that pushes
 * into a Map. Flushing is async background work.
 */

interface BucketSample {
  requests:        number
  errors:          number   // 5xx
  clientErrors:    number   // 4xx
  totalDurationMs: number
  maxDurationMs:   number
  samples:         number[] // reservoir of up to 200 durations for p50/p99
}

const MAX_RESERVOIR = 200

// key = `${endpoint}|${hourISO}`
const buckets = new Map<string, BucketSample>()

function bucketKey(endpoint: string, hour: Date): string {
  return `${endpoint}|${hour.toISOString()}`
}

function hourTrunc(d: Date): Date {
  const t = new Date(d); t.setMinutes(0, 0, 0); return t
}

function normalizeEndpoint(req: Request): string {
  // Use the route definition (with :params) when available so /anime/123
  // and /anime/456 collapse into one bucket.
  const route = (req.route as { path?: string } | undefined)?.path
  const base  = req.baseUrl ?? ""
  const path  = route ? `${base}${route}` : req.path
  return `${req.method} ${path}`
}

function reservoirInsert(samples: number[], value: number): void {
  if (samples.length < MAX_RESERVOIR) { samples.push(value); return }
  const idx = Math.floor(Math.random() * samples.length)
  samples[idx] = value
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0
  const sorted = samples.slice().sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return Math.round(sorted[idx])
}

export function slaMetrics() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = Date.now()
    res.on("finish", () => {
      try {
        const dur     = Date.now() - start
        const hour    = hourTrunc(new Date())
        const endpoint = normalizeEndpoint(req)
        const key     = bucketKey(endpoint, hour)
        const b = buckets.get(key) ?? {
          requests: 0, errors: 0, clientErrors: 0,
          totalDurationMs: 0, maxDurationMs: 0, samples: [],
        }
        b.requests++
        if (res.statusCode >= 500) b.errors++
        else if (res.statusCode >= 400) b.clientErrors++
        b.totalDurationMs += dur
        if (dur > b.maxDurationMs) b.maxDurationMs = dur
        reservoirInsert(b.samples, dur)
        buckets.set(key, b)
      } catch {/* never break the request path */}
    })
    next()
  }
}

/** Flush in-process buckets to the DB. Idempotent — uses upsert. */
export async function flushSlaMetrics(): Promise<{ flushed: number }> {
  if (buckets.size === 0) return { flushed: 0 }
  // Snapshot + clear so new writes go into fresh buckets while we flush.
  const snapshot = new Map(buckets)
  buckets.clear()

  let flushed = 0
  for (const [key, b] of snapshot) {
    const [endpoint, hourISO] = key.split("|")
    const hourBucket = new Date(hourISO)
    const p50 = percentile(b.samples, 0.50)
    const p99 = percentile(b.samples, 0.99)
    try {
      const existing = await prisma.endpointStat.findUnique({
        where: { endpoint_hourBucket: { endpoint, hourBucket } },
      })
      if (existing) {
        const totalReq = existing.requests + b.requests
        // Weighted p50/p99 isn't exact across flushes — we keep the higher
        // of new vs old as a pragmatic compromise. Per-hour buckets stabilize
        // quickly so this is fine for the admin overview.
        await prisma.endpointStat.update({
          where: { endpoint_hourBucket: { endpoint, hourBucket } },
          data: {
            requests:        totalReq,
            errors:          existing.errors + b.errors,
            clientErrors:    existing.clientErrors + b.clientErrors,
            totalDurationMs: existing.totalDurationMs + BigInt(b.totalDurationMs),
            maxDurationMs:   Math.max(existing.maxDurationMs, b.maxDurationMs),
            p50Ms:           Math.max(existing.p50Ms, p50),
            p99Ms:           Math.max(existing.p99Ms, p99),
          },
        })
      } else {
        await prisma.endpointStat.create({
          data: {
            endpoint, hourBucket,
            requests: b.requests, errors: b.errors, clientErrors: b.clientErrors,
            totalDurationMs: BigInt(b.totalDurationMs),
            maxDurationMs: b.maxDurationMs, p50Ms: p50, p99Ms: p99,
          },
        })
      }
      flushed++
    } catch (err) {
      console.error("[slaMetrics] flush failed for", key, err)
    }
  }
  return { flushed }
}
