import { Request, Response, NextFunction } from "express";
import * as service from "./creator.service";

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
