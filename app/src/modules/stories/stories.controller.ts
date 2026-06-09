import { Request, Response, NextFunction } from "express";
import { badRequest } from "../../lib/errors";
import { createStorySchema } from "./stories.schema";
import * as service from "./stories.service";

export async function getFeed(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const result = await service.getFeed(userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function createStory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const parsed = createStorySchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid story payload");
    const story = await service.createStory(userId, parsed.data);
    res.status(201).json({ story });
  } catch (err) {
    next(err);
  }
}

export async function markViewed(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    await service.markViewed(userId, req.params.id as string);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function deleteStory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    await service.deleteStory(userId, req.params.id as string);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function listViewers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    res.status(200).json(await service.listViewers(userId, req.params.id as string));
  } catch (err) {
    next(err);
  }
}
