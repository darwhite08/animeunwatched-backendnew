import { Request, Response, NextFunction } from "express";
import { badRequest } from "../../lib/errors";
import { createShotSchema } from "./shots.schema";
import * as service from "./shots.service";

export async function getFeed(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string | undefined = res.locals.user?.id;
    const cursor = req.query.cursor as string | undefined;
    const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 10));
    const result = await service.getFeed(userId, cursor, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getUserShots(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const viewerId: string | undefined = res.locals.user?.id;
    const cursor = req.query.cursor as string | undefined;
    const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 12));
    const result = await service.getUserShots(req.params.userId as string, viewerId, cursor, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function createShot(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const parsed = createShotSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid shot payload");
    const shot = await service.createShot(userId, parsed.data);
    res.status(201).json({ shot });
  } catch (err) {
    next(err);
  }
}

export async function deleteShot(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    await service.deleteShot(userId, req.params.id as string);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function likeShot(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const result = await service.likeShot(userId, req.params.id as string);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function unlikeShot(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const result = await service.unlikeShot(userId, req.params.id as string);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
