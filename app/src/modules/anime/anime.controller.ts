import { Request, Response, NextFunction } from "express";
import { browseQuerySchema } from "./anime.schema";
import * as service from "./anime.service";

export async function browse(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = browseQuerySchema.parse(req.query);
    const result = await service.browse(query);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getById(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const malId = Number(req.params.malId);
    const userId: string | undefined = res.locals.user?.id;
    const result = await service.getById(malId, userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function search(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = (req.query.q as string) || "";
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const result = await service.search(q, page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getSeasonal(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const year = Number(req.params.year);
    const season = req.params.season as "winter" | "spring" | "summer" | "fall";
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const result = await service.getSeasonal(year, season, page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
