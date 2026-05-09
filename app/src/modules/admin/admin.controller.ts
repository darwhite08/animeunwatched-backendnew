import { Request, Response, NextFunction } from "express";
import * as service from "./admin.service";

export async function getStats(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.getStats();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getRecentUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const result = await service.getRecentUsers(limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getPlatformHealth(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.getPlatformHealth();
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
