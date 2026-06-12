import { Request, Response, NextFunction } from "express";
import * as service from "./readlist.service";
import { addMangaSchema, updateMangaSchema } from "./readlist.schema";
import { badRequest } from "../../lib/errors";

export async function search(req: Request, res: Response, next: NextFunction) {
  try {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) { res.status(200).json({ data: [] }); return; }
    res.status(200).json(await service.search(q));
  } catch (err) { next(err); }
}

export async function getMine(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await service.getMine(res.locals.user.id as string));
  } catch (err) { next(err); }
}

export async function getByUsername(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await service.getByUsername(String(req.params.username)));
  } catch (err) { next(err); }
}

export async function add(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = addMangaSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid manga payload");
    res.status(201).json(await service.add(res.locals.user.id as string, parsed.data));
  } catch (err) { next(err); }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = updateMangaSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid update payload");
    res.status(200).json(await service.update(res.locals.user.id as string, String(req.params.id), parsed.data));
  } catch (err) { next(err); }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    await service.remove(res.locals.user.id as string, String(req.params.id));
    res.status(204).send();
  } catch (err) { next(err); }
}
