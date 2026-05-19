import { Request, Response, NextFunction } from "express";
import * as service from "./notifications.service";

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const page  = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const result = await service.list(userId, page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getUnreadCount(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const result = await service.getUnreadCount(userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function markRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const id = req.params.id as string;
    const result = await service.markRead(userId, id);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function markAllRead(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const result = await service.markAllRead(userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
