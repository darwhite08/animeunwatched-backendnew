import { Request, Response, NextFunction } from "express"

const store = new Map<string, { count: number; resetAt: number }>()

export function rateLimit(limit: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown"
    const now = Date.now()
    const entry = store.get(key)

    res.set("X-RateLimit-Limit", String(limit))

    if (!entry || now > entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs })
      res.set("X-RateLimit-Remaining", String(limit - 1))
      return next()
    }

    if (entry.count >= limit) {
      res.set("X-RateLimit-Remaining", "0")
      res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests" } })
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
