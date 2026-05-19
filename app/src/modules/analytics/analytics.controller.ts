import { Request, Response, NextFunction } from "express";
import * as analyticsService from "./analytics.service";

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
