import { Request, Response, NextFunction } from "express"

export function responseTime(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint()
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000
    if (!res.headersSent) res.setHeader("X-Response-Time", `${ms.toFixed(2)}ms`)
  })
  next()
}

export function requestLogger(req: Request, _res: Response, next: NextFunction) {
  if (process.env.NODE_ENV !== "production") {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`)
  }
  next()
}
