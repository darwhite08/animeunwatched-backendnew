import { Request, Response, NextFunction } from "express";
import { createClubSchema, updateClubSchema } from "./clubs.schema";
import * as service from "./clubs.service";

export async function listClubs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const result = await service.list(page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getClubBySlug(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await service.getBySlug(req.params.slug as string);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function createClub(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ownerId: string = res.locals.user.id;
    const dto = createClubSchema.parse(req.body);
    const result = await service.create(ownerId, dto);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function joinClub(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const result = await service.join(userId, req.params.slug as string);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function leaveClub(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    await service.leave(userId, req.params.slug as string);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function setMemberRole(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const actorId: string = res.locals.user.id;
    const { slug, userId: targetUserId } = req.params as { slug: string; userId: string };
    const { role } = req.body as { role: "USER" | "MOD" | "ADMIN" };
    const result = await service.setMemberRole(actorId, slug, targetUserId, role);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateClub(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId: string = res.locals.user.id;
    const dto = updateClubSchema.parse(req.body);
    const result = await service.update(req.params.slug as string, actorId, dto);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
