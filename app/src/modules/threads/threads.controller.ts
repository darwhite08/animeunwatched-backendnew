import { Request, Response, NextFunction } from "express";
import { createThreadSchema, updateThreadSchema, createReplySchema } from "./threads.schema";
import * as service from "./threads.service";

export async function getThreadById(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await service.getById(req.params.id as string, res.locals.user?.id);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function reactThread(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const emoji = String((req.body ?? {}).emoji ?? "").slice(0, 32);
    if (!emoji) throw (await import("../../lib/errors")).badReq("emoji required");
    res.status(200).json(await service.setReaction(req.params.id as string, "thread", userId, emoji));
  } catch (err) { next(err); }
}

export async function reactReply(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const emoji = String((req.body ?? {}).emoji ?? "").slice(0, 32);
    if (!emoji) throw (await import("../../lib/errors")).badReq("emoji required");
    res.status(200).json(await service.setReaction(req.params.replyId as string, "reply", userId, emoji));
  } catch (err) { next(err); }
}

export async function lockThread(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const locked = (req.body ?? {}).locked !== false; // default lock=true
    res.status(200).json(await service.setThreadLock(userId, req.params.id as string, locked));
  } catch (err) { next(err); }
}

export async function createClubThread(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authorId: string = res.locals.user.id;
    const dto = createThreadSchema.parse(req.body);
    const result = await service.createClubThread(authorId, req.params.slug as string, dto);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function createAnimeThread(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authorId: string = res.locals.user.id;
    const malId = Number(req.params.malId);
    const dto = createThreadSchema.parse(req.body);
    const result = await service.createAnimeThread(authorId, malId, dto);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateThread(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const userRole: string = res.locals.user.role;
    const dto = updateThreadSchema.parse(req.body);
    const result = await service.update(req.params.id as string, userId, userRole, dto);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function deleteThread(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const userRole: string = res.locals.user.role;
    await service.deleteThread(req.params.id as string, userId, userRole);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function getReplies(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const page  = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const result = await service.getReplies(req.params.id as string, page, limit, res.locals.user?.id);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function createReply(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authorId: string = res.locals.user.id;
    const dto = createReplySchema.parse(req.body);
    const result = await service.createReply(req.params.id as string, authorId, dto);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getAnimeThreads(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const malId = Number(req.params.malId);
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const result = await service.getAnimeThreads(malId, page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getClubThreads(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const slug = req.params.slug as string;
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const result = await service.getClubThreads(slug, page, limit, res.locals.user?.id);
    res.status(200).json(result);
  } catch (err) { next(err); }
}
