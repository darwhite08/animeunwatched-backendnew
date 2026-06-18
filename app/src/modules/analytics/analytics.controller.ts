import { Request, Response, NextFunction } from "express";
import * as analyticsService from "./analytics.service";
import { recordPageview } from "../../lib/realtimeAnalytics";
import { getIpProfile } from "../../lib/geoip";

/** Real client IP behind the App Runner ALB / Vercel proxy (XFF first hop). */
function clientIp(req: Request): string | null {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  return req.ip ?? null;
}

export async function platformStats(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const stats = await analyticsService.getPlatformStats();
    res.json(stats);
  } catch (err) {
    next(err);
  }
}

export async function topAnime(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(100, Number(req.query.limit) || 10);
    const anime = await analyticsService.getTopAnime(limit);
    res.json({ data: anime });
  } catch (err) {
    next(err);
  }
}

export async function reputationLeaderboard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const data = await analyticsService.getReputationLeaderboard(limit);
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

export async function recentActivity(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const activity = await analyticsService.getRecentActivity(limit);
    res.json(activity);
  } catch (err) {
    next(err);
  }
}

/**
 * Lightweight pageview pinger. Anonymous-friendly: doesn't require auth.
 * Body shape: { path, visitorId } — visitorId is a cookie-stable random
 * string the client generates. No PII.
 */
export function pageview(req: Request, res: Response): void {
  const body = req.body as { path?: unknown; visitorId?: unknown } | undefined
  const path      = typeof body?.path      === "string" ? body.path      : null
  const visitorId = typeof body?.visitorId === "string" ? body.visitorId : null
  if (!path || !visitorId) {
    res.status(204).send()  // Silent reject — never block the user
    return
  }
  const userId = res.locals.user?.id ?? null
  // Ack immediately; resolve geo (IP→country/state, cached, no GPS) without
  // blocking the response. Cold IPs return null and self-populate the cache,
  // so their first ping records geo-less and subsequent ones carry it.
  res.status(204).send()
  const ip = clientIp(req)
  void (async () => {
    let country: string | null = null, countryName: string | null = null, region: string | null = null
    if (ip) {
      try {
        const geo = await getIpProfile(ip)
        if (geo) { country = geo.country; countryName = geo.countryName; region = geo.region }
      } catch { /* geo is best-effort */ }
    }
    recordPageview({ path, visitorId, userId, country, countryName, region })
  })()
}
