import { Request, Response, NextFunction } from "express"

export function apiVersionHeader(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-API-Version", "1.0.0")
  next()
}
