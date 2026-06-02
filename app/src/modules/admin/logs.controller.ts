import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { flushLogs } from "../../lib/logSink"

export async function listLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const level   = typeof req.query.level   === "string" ? req.query.level   : undefined
    const search  = typeof req.query.search  === "string" ? req.query.search  : undefined
    const traceId = typeof req.query.traceId === "string" ? req.query.traceId : undefined
    const hours   = Math.min(168, Math.max(1, Number(req.query.hours) || 24))
    const since   = new Date(Date.now() - hours * 60 * 60_000)

    const where: Record<string, unknown> = { createdAt: { gte: since } }
    if (level)   where.level = level
    if (traceId) where.traceId = traceId
    if (search)  where.message = { contains: search, mode: "insensitive" }

    const data = await prisma.logEntry.findMany({
      where, orderBy: { createdAt: "desc" }, take: 500,
    })

    const counters: Record<string, number> = {}
    for (const r of data) counters[r.level] = (counters[r.level] ?? 0) + 1
    res.status(200).json({ data, counters, windowHours: hours })
  } catch (err) { next(err) }
}

export async function forceFlush(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const r = await flushLogs()
    res.status(200).json(r)
  } catch (err) { next(err) }
}
