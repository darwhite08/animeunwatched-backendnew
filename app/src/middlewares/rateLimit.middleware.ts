import { Request, Response, NextFunction } from "express"
import { prisma } from "../config/prisma"

/**
 * Distributed fixed-window rate limiter backed by Postgres (RateLimitBucket), so
 * the limit holds across all App Runner instances instead of per-process.
 *
 * Each check is a single atomic upsert: it inserts a fresh window, or — if the
 * row's window has expired — resets it, otherwise increments. Whether the
 * request is allowed is decided from the returned count, with no read-modify-
 * write race.
 *
 * Fails OPEN: if the DB is briefly unreachable we allow the request rather than
 * lock everyone out — a rate limiter must never become a single point of outage.
 * (The login brute-force lockout in auth.service is a separate, fail-closed
 * control for the security-critical path.)
 */

type RateLimitOpts = {
  // Key the bucket by the authenticated user instead of IP (DM write paths).
  // Falls back to IP when no user is present.
  perUser?: boolean
  // Namespace so multiple limiters on the same user don't share a bucket.
  bucket?: string
}

export function rateLimit(limit: number, windowMs: number, opts: RateLimitOpts = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ns = opts.bucket ? `${opts.bucket}:` : ""
    const ident = opts.perUser
      ? (res.locals?.user?.id ? `u:${res.locals.user.id}` : `ip:${req.ip ?? "unknown"}`)
      : (req.ip ?? "unknown")
    const key = `${ns}${ident}`
    const newReset = new Date(Date.now() + windowMs)

    res.set("X-RateLimit-Limit", String(limit))

    let count: number
    let resetAt: Date
    try {
      // Atomic: insert a new window, or reset/increment the existing one.
      const rows = await prisma.$queryRaw<Array<{ count: number; resetAt: Date }>>`
        INSERT INTO "RateLimitBucket" ("key", "count", "resetAt")
        VALUES (${key}, 1, ${newReset})
        ON CONFLICT ("key") DO UPDATE SET
          "count"   = CASE WHEN "RateLimitBucket"."resetAt" <= now() THEN 1 ELSE "RateLimitBucket"."count" + 1 END,
          "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= now() THEN ${newReset} ELSE "RateLimitBucket"."resetAt" END
        RETURNING "count", "resetAt"`
      count = rows[0].count
      resetAt = rows[0].resetAt
    } catch (err) {
      // DB hiccup → fail open (never block legitimate traffic on a limiter error).
      console.error("[rateLimit] store error, allowing request:", err)
      res.set("X-RateLimit-Remaining", String(limit - 1))
      return next()
    }

    if (count > limit) {
      const retryAfterSec = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000))
      res.set("X-RateLimit-Remaining", "0")
      res.set("Retry-After", String(retryAfterSec))
      res.status(429).json({
        error: {
          code: "RATE_LIMITED",
          message: `Too many requests. Try again in ${retryAfterSec} seconds.`,
        },
      })
      return
    }

    res.set("X-RateLimit-Remaining", String(Math.max(0, limit - count)))
    next()
  }
}
