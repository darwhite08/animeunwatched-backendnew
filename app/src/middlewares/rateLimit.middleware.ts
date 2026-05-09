import { Request, Response, NextFunction } from "express"

const store = new Map<string, { count: number; resetAt: number }>()

export function rateLimit(limit: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown"
    const now = Date.now()
    const entry = store.get(key)

    if (!entry || now > entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs })
      return next()
    }

    if (entry.count >= limit) {
      res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests" } })
      return
    }

    entry.count++
    next()
  }
}

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now()
  store.forEach((v, k) => { if (now > v.resetAt) store.delete(k) })
}, 5 * 60_000)
