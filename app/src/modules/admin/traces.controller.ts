import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { notFound } from "../../lib/errors"

export async function listTraces(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const status   = typeof req.query.status   === "string" ? req.query.status   : undefined
    const minMs    = Number(req.query.minMs) || 0
    const endpoint = typeof req.query.endpoint === "string" ? req.query.endpoint : undefined
    const hours    = Math.min(168, Math.max(1, Number(req.query.hours) || 24))
    const since    = new Date(Date.now() - hours * 60 * 60_000)

    const where: Record<string, unknown> = {
      parentSpanId: null,                      // root spans only on the list view
      startedAt:    { gte: since },
    }
    if (status)   where.status     = status
    if (minMs > 0) where.durationMs = { gte: minMs }
    if (endpoint) where.name       = { contains: endpoint, mode: "insensitive" }

    const data = await prisma.traceSpan.findMany({
      where, orderBy: { startedAt: "desc" }, take: 200,
      select: { id: true, traceId: true, name: true, status: true, durationMs: true, startedAt: true, attributes: true },
    })

    // Summary stats
    const allRecent = await prisma.traceSpan.findMany({
      where: { parentSpanId: null, startedAt: { gte: since } },
      select: { status: true, durationMs: true },
    })
    const total      = allRecent.length
    const errors     = allRecent.filter(r => r.status === "error").length
    const overP99    = allRecent.length === 0 ? 0 :
      allRecent.slice().sort((a, b) => a.durationMs - b.durationMs)[Math.floor(allRecent.length * 0.99) - 1]?.durationMs ?? 0
    res.status(200).json({
      windowHours: hours,
      totals:      { sampled: total, errors, errorRatePct: total > 0 ? +(errors / total * 100).toFixed(2) : 0, p99Ms: overP99 },
      data,
    })
  } catch (err) { next(err) }
}

export async function getTrace(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const traceId = req.params.traceId as string
    const spans = await prisma.traceSpan.findMany({
      where: { traceId }, orderBy: { startedAt: "asc" },
    })
    if (spans.length === 0) throw notFound("Trace not found")
    res.status(200).json({ traceId, spans })
  } catch (err) { next(err) }
}
