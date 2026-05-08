import { Request, Response, NextFunction } from "express";
import { upsertEntrySchema } from "./lists.schema";
import * as service from "./lists.service";

export async function getUserList(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const username = req.params.username as string;
    const status = req.query.status as string | undefined;
    const sort = req.query.sort as string | undefined;
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const result = await service.getUserList(username, status, sort, page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function upsertEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const animeId = req.params.animeId as string;
    const dto = upsertEntrySchema.parse(req.body);
    const result = await service.upsertEntry(userId, animeId, dto);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function deleteEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const animeId = req.params.animeId as string;
    await service.deleteEntry(userId, animeId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
