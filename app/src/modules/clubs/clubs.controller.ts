import { Request, Response, NextFunction } from "express";
import { createClubSchema, updateClubSchema } from "./clubs.schema";
import * as service from "./clubs.service";
import { badReq } from "../../lib/errors";

const VALID_MEMBER_ROLES = ["USER", "MOD", "ADMIN"] as const;

export async function listClubs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const category = typeof req.query.category === "string" ? req.query.category.trim().slice(0, 40) : "";
    const result = await service.list(page, limit, q || undefined, category || undefined);
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
    const result = await service.getBySlug(req.params.slug as string, res.locals.user?.id);
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
    const { role } = req.body as { role: string };
    if (!VALID_MEMBER_ROLES.includes(role as typeof VALID_MEMBER_ROLES[number])) {
      throw badReq(`role must be one of: ${VALID_MEMBER_ROLES.join(", ")}`);
    }
    const result = await service.setMemberRole(actorId, slug, targetUserId, role as "USER" | "MOD" | "ADMIN");
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

export async function getClubMembers(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const result = await service.getClubMembers(req.params.slug as string, page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function clubChat(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const result = await service.getOrCreateClubChat(userId, req.params.slug as string);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function onboard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    res.status(200).json(await service.onboard(userId, req.params.slug as string));
  } catch (err) { next(err); }
}

export async function leaderboard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const period = req.query.period === "week" ? "week" : "all";
    res.status(200).json(await service.leaderboard(req.params.slug as string, period));
  } catch (err) { next(err); }
}

export async function muteMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId: string = res.locals.user.id;
    const { slug, userId: targetId } = req.params as { slug: string; userId: string };
    const minutes = Number((req.body ?? {}).minutes) || 0;
    res.status(200).json(await service.muteMember(actorId, slug, targetId, minutes));
  } catch (err) { next(err); }
}

export async function removeMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId: string = res.locals.user.id;
    const { slug, userId: targetId } = req.params as { slug: string; userId: string };
    res.status(200).json(await service.removeClubMember(actorId, slug, targetId));
  } catch (err) { next(err); }
}

export async function listClubPolls(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await service.listClubPolls(req.params.slug as string, res.locals.user?.id));
  } catch (err) { next(err); }
}

export async function createClubPoll(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const { question, options, expiresInDays } = req.body ?? {};
    res.status(201).json(await service.createClubPoll(userId, req.params.slug as string, { question, options, expiresInDays }));
  } catch (err) { next(err); }
}
