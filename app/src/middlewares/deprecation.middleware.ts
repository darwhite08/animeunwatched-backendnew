import type { Request, Response, NextFunction } from "express"
import { prisma } from "../config/prisma"

/**
 * Adds RFC 8594 Sunset + Deprecation headers when the current endpoint
 * matches a registered DeprecatedEndpoint row. Cached in-process for 60s
 * so we don't hit the DB on every request.
 */

interface CacheEntry { sunsetAt: Date; reason: string | null; replacement: string | null }
let cache: { byEndpoint: Map<string, CacheEntry>; refreshedAt: number } | null = null
const CACHE_TTL_MS = 60_000

async function getCache(): Promise<Map<string, CacheEntry>> {
  if (cache && Date.now() - cache.refreshedAt < CACHE_TTL_MS) return cache.byEndpoint
  const rows = await prisma.deprecatedEndpoint.findMany().catch(() => [])
  const byEndpoint = new Map<string, CacheEntry>()
  for (const r of rows) {
    byEndpoint.set(r.endpoint, { sunsetAt: r.sunsetAt, reason: r.reason, replacement: r.replacement })
  }
  cache = { byEndpoint, refreshedAt: Date.now() }
  return byEndpoint
}

export function invalidateDeprecationCache(): void { cache = null }

function endpointKey(req: Request): string {
  const route = (req.route as { path?: string } | undefined)?.path
  const base  = req.baseUrl ?? ""
  return `${req.method} ${route ? base + route : req.path}`
}

export function deprecationHeaders() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const map = await getCache()
      const hit = map.get(endpointKey(req))
      if (hit) {
        // RFC 8594 Sunset
        res.setHeader("Sunset", hit.sunsetAt.toUTCString())
        // Deprecation indicator (draft-ietf-httpapi-deprecation-header)
        res.setHeader("Deprecation", "true")
        if (hit.replacement) {
          res.setHeader("Link", `<${hit.replacement}>; rel="successor-version"`)
        }
      }
    } catch {/* never block the request */}
    next()
  }
}
