import { Request, Response, NextFunction } from "express";
import { badRequest } from "../../lib/errors";
import { createShotSchema } from "./shots.schema";
import * as service from "./shots.service";

export async function getFeed(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string | undefined = res.locals.user?.id;
    const cursor = req.query.cursor as string | undefined;
    const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 10));
    const filter = req.query.filter === "following" ? "following" : undefined;
    const result = await service.getFeed(userId, cursor, limit, filter);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getSaved(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const cursor = req.query.cursor as string | undefined;
    const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 12));
    res.status(200).json(await service.getSaved(userId, cursor, limit));
  } catch (err) {
    next(err);
  }
}

export async function saveShot(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    res.status(200).json(await service.saveShot(userId, req.params.id as string));
  } catch (err) {
    next(err);
  }
}

export async function unsaveShot(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    res.status(200).json(await service.unsaveShot(userId, req.params.id as string));
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

export async function listComments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.listComments(req.params.id as string, res.locals.user?.id);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function createComment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const body = typeof req.body?.body === "string" ? req.body.body : "";
    const parentId = typeof req.body?.parentId === "string" ? req.body.parentId : undefined;
    const result = await service.createComment(userId, req.params.id as string, body, parentId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function deleteComment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    await service.deleteComment(userId, req.params.commentId as string);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function likeComment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await service.likeComment(res.locals.user.id, req.params.commentId as string));
  } catch (err) { next(err); }
}

export async function unlikeComment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await service.unlikeComment(res.locals.user.id, req.params.commentId as string));
  } catch (err) { next(err); }
}

export async function pinComment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const pinned = req.body?.pinned !== false; // default true
    res.status(200).json(await service.pinComment(res.locals.user.id, req.params.commentId as string, pinned));
  } catch (err) { next(err); }
}
