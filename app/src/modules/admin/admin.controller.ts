import { Request, Response, NextFunction } from "express";
import * as service from "./admin.service";
import { badRequest } from "../../lib/errors";
import { getLiveSnapshot } from "../../lib/realtimeAnalytics";
import { getGA4Realtime, isGA4Configured } from "../../lib/ga4";

export async function getStats(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.getStats();
    res.status(200).json(result);
  } catch (err) { next(err); }
}

export async function getRecentUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const result = await service.getRecentUsers(limit);
    res.status(200).json(result);
  } catch (err) { next(err); }
}

export async function getPlatformHealth(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.getPlatformHealth();
    res.status(200).json(result);
  } catch (err) { next(err); }
}

export async function listReports(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page   = Number(req.query.page)   || 1
    const limit  = Number(req.query.limit)  || 20
    const status = req.query.status as string | undefined
    const result = await service.listReports(page, limit, status)
    res.status(200).json(result)
  } catch (err) { next(err) }
}

export async function resolveReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const reportId = req.params.reportId as string
    const { status }   = req.body as { status: "RESOLVED" | "DISMISSED" }
    const modId        = res.locals.user?.id as string
    const result       = await service.resolveReport(reportId, status, modId)
    res.status(200).json(result)
  } catch (err) { next(err) }
}

// ─── New dashboard endpoints ──────────────────────────────────────────────────

export async function listUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const search = typeof req.query.search === "string" ? req.query.search : undefined
    const role   = req.query.role as "USER" | "MOD" | "ADMIN" | undefined
    const banned = req.query.banned === "true" ? true : req.query.banned === "false" ? false : undefined
    const page   = Math.max(1, Number(req.query.page) || 1)
    const limit  = Math.min(100, Math.max(1, Number(req.query.limit) || 25))
    const result = await service.listUsers({ search, role, banned, page, limit })
    res.status(200).json(result)
  } catch (err) { next(err) }
}

export async function getUserDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.params.userId as string
    const result = await service.getUserDetail(userId)
    res.status(200).json(result)
  } catch (err) { next(err) }
}

export async function banUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId  = req.params.userId as string
    const actorId = res.locals.user?.id as string
    const reason  = typeof req.body?.reason === "string" ? req.body.reason : null
    const result  = await service.setUserBan({ actorId, userId, banned: true, reason })
    res.status(200).json(result)
  } catch (err) { next(err) }
}

export async function unbanUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId  = req.params.userId as string
    const actorId = res.locals.user?.id as string
    const result  = await service.setUserBan({ actorId, userId, banned: false })
    res.status(200).json(result)
  } catch (err) { next(err) }
}

export async function setUserRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId  = req.params.userId as string
    const actorId = res.locals.user?.id as string
    const role    = req.body?.role as "USER" | "MOD" | "ADMIN" | undefined
    if (!role || !["USER", "MOD", "ADMIN"].includes(role)) {
      throw badRequest("role must be USER, MOD, or ADMIN")
    }
    const result = await service.setUserRole({ actorId, userId, role })
    res.status(200).json(result)
  } catch (err) { next(err) }
}

export async function listAuditLog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const type   = typeof req.query.type === "string" ? req.query.type : undefined
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined
    const page   = Math.max(1, Number(req.query.page) || 1)
    const limit  = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    const result = await service.listAuditLog({ type, userId, page, limit })
    res.status(200).json(result)
  } catch (err) { next(err) }
}

export async function getMetricsOverview(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.getMetricsOverview()
    res.status(200).json(result)
  } catch (err) { next(err) }
}

export function getAnalyticsLive(_req: Request, res: Response): void {
  res.status(200).json(getLiveSnapshot())
}

/**
 * GA4 realtime snapshot. Returns 200 with { configured: false } when
 * the env vars aren't set so the frontend can render the "connect GA4"
 * placeholder without lighting up an error state.
 */
export async function getGAAnalyticsLive(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!isGA4Configured()) {
      res.status(200).json({ configured: false })
      return
    }
    const snap = await getGA4Realtime()
    if (!snap) {
      res.status(200).json({ configured: true, available: false })
      return
    }
    res.status(200).json({ configured: true, available: true, ...snap })
  } catch (err) { next(err) }
}
