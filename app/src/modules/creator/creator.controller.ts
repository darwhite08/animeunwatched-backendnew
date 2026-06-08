import { Request, Response, NextFunction } from "express";
import * as service from "./creator.service";
import * as analytics from "./analytics.service";

function range(req: Request): string {
  const r = (req.query.range as string) || "28d";
  return /^\d+d$/.test(r) ? r : "28d";
}

export async function getAnalyticsOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await analytics.getOverview(res.locals.user.id, range(req)));
  } catch (err) { next(err); }
}

export async function getAnalyticsContent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await analytics.getContentAnalytics(res.locals.user.id, range(req)));
  } catch (err) { next(err); }
}

export async function getAnalyticsAudience(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await analytics.getAudience(res.locals.user.id, range(req)));
  } catch (err) { next(err); }
}

export async function getAnalyticsInsights(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await analytics.getInsights(res.locals.user.id, range(req)));
  } catch (err) { next(err); }
}

export async function getAnalyticsRealtime(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await analytics.getRealtime(res.locals.user.id)); } catch (err) { next(err); }
}

export async function getContentIdeas(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await analytics.getContentIdeas()); } catch (err) { next(err); }
}

export async function getCreatorStats(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const result = await service.getCreatorStats(userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getContentPerformance(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const result = await service.getContentPerformance(userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getDailySeries(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    res.status(200).json({ data: await service.getDailySeries(userId) });
  } catch (err) {
    next(err);
  }
}

export async function getAccess(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await service.getCreatorAccess(res.locals.user.id));
  } catch (err) { next(err); }
}

export async function getMyBlogs(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await service.getMyBlogs(res.locals.user.id)); } catch (err) { next(err); }
}

export async function getMyPosts(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await service.getMyPosts(res.locals.user.id)); } catch (err) { next(err); }
}

export async function getEngagementInbox(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await service.getEngagementInbox(res.locals.user.id)); } catch (err) { next(err); }
}

export async function getMyPolls(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await service.getMyPolls(res.locals.user.id)); } catch (err) { next(err); }
}
