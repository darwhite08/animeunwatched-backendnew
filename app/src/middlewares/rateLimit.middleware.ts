import { Request, Response, NextFunction } from "express"

const store = new Map<string, { count: number; resetAt: number }>()

type RateLimitOpts = {
  // Key the bucket by the authenticated user instead of IP (DM write paths).
  // Falls back to IP when no user is present.
  perUser?: boolean
  // Namespace so multiple limiters on the same user don't share a bucket.
  bucket?: string
}

export function rateLimit(limit: number, windowMs: number, opts: RateLimitOpts = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ns = opts.bucket ? `${opts.bucket}:` : ""
    const ident = opts.perUser
      ? (res.locals?.user?.id ? `u:${res.locals.user.id}` : `ip:${req.ip ?? "unknown"}`)
      : (req.ip ?? "unknown")
    const key = `${ns}${ident}`
    const now = Date.now()
    const entry = store.get(key)

    res.set("X-RateLimit-Limit", String(limit))

    if (!entry || now > entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs })
      res.set("X-RateLimit-Remaining", String(limit - 1))
      return next()
    }

    if (entry.count >= limit) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000)
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

    entry.count++
    res.set("X-RateLimit-Remaining", String(Math.max(0, limit - entry.count)))
    next()
  }
}

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now()
  store.forEach((v, k) => { if (now > v.resetAt) store.delete(k) })
}, 5 * 60_000)
