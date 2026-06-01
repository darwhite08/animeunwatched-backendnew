import type { Request, Response, NextFunction } from "express";
import * as service from "./activities.service";
import {
  createActivitySchema, createReplySchema, feedQuerySchema, repostActivitySchema,
} from "./activities.schema";

function uid(res: Response): string {
  return res.locals.user.id as string;
}
function optUid(res: Response): string | undefined {
  return res.locals.user?.id as string | undefined;
}

export async function createActivity(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = createActivitySchema.parse(req.body);
    const activity = await service.createActivity(uid(res), dto);
    res.status(201).json({ activity });
  } catch (e) { next(e); }
}

export async function getFeed(req: Request, res: Response, next: NextFunction) {
  try {
    const q = feedQuerySchema.parse(req.query);
    const result = await service.getFeed(optUid(res), q);
    res.json(result);
  } catch (e) { next(e); }
}

export async function getActivity(req: Request, res: Response, next: NextFunction) {
  try {
    const activity = await service.getActivity(req.params.id as string, optUid(res));
    res.json({ activity });
  } catch (e) { next(e); }
}

export async function deleteActivity(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.deleteActivity(req.params.id as string, uid(res));
    res.json(result);
  } catch (e) { next(e); }
}

// ─── engagement ──────────────────────────────────────────────────────────────

export async function likeActivity(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.likeActivity(uid(res), req.params.id as string);
    res.json(result);
  } catch (e) { next(e); }
}

export async function unlikeActivity(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.unlikeActivity(uid(res), req.params.id as string);
    res.json(result);
  } catch (e) { next(e); }
}

export async function repostActivity(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = repostActivitySchema.parse(req.body ?? {});
    const result = await service.repostActivity(uid(res), req.params.id as string, dto);
    res.status(201).json(result);
  } catch (e) { next(e); }
}

export async function unrepostActivity(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.unrepostActivity(uid(res), req.params.id as string);
    res.json(result);
  } catch (e) { next(e); }
}

// ─── replies ─────────────────────────────────────────────────────────────────

export async function createReply(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = createReplySchema.parse(req.body);
    const reply = await service.createReply(uid(res), req.params.id as string, dto);
    res.status(201).json({ reply });
  } catch (e) { next(e); }
}

export async function getReplies(req: Request, res: Response, next: NextFunction) {
  try {
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const limit  = req.query.limit ? Number(req.query.limit) : 20;
    const result = await service.getReplies(req.params.id as string, cursor, limit);
    res.json(result);
  } catch (e) { next(e); }
}
