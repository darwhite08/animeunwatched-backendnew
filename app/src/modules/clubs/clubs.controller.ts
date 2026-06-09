import { Request, Response, NextFunction } from "express";
import { createClubSchema, updateClubSchema, createInviteSchema } from "./clubs.schema";
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
    const message = typeof req.body?.message === "string" ? req.body.message : undefined;
    const result = await service.join(userId, req.params.slug as string, message);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function setVerified(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const verified = req.body?.verified !== false; // default true
    res.status(200).json(await service.setClubVerified(req.params.slug as string, verified));
  } catch (err) { next(err); }
}

export async function createInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId: string = res.locals.user.id;
    const dto = createInviteSchema.parse(req.body ?? {});
    res.status(201).json(await service.createInvite(actorId, req.params.slug as string, dto));
  } catch (err) { next(err); }
}

export async function inviteInfo(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await service.getInviteInfo(req.params.code as string));
  } catch (err) { next(err); }
}

export async function joinViaInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    res.status(201).json(await service.joinViaInvite(userId, req.params.code as string));
  } catch (err) { next(err); }
}

export async function listJoinRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId: string = res.locals.user.id;
    res.status(200).json(await service.listJoinRequests(actorId, req.params.slug as string));
  } catch (err) { next(err); }
}

export async function decideJoinRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId: string = res.locals.user.id;
    const { slug, userId: targetUserId } = req.params as { slug: string; userId: string };
    const approve = req.body?.approve === true || req.body?.approve === "true";
    res.status(200).json(await service.decideJoinRequest(actorId, slug, targetUserId, approve));
  } catch (err) { next(err); }
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

export async function getWatchlist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await service.getWatchlist(req.params.slug as string)); }
  catch (err) { next(err); }
}
export async function addWatchlist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId: string = res.locals.user.id;
    const { malId, title, imageUrl } = req.body ?? {};
    res.status(201).json(await service.addToWatchlist(actorId, req.params.slug as string, { malId: Number(malId), title: String(title ?? ""), imageUrl }));
  } catch (err) { next(err); }
}
export async function removeWatchlist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId: string = res.locals.user.id;
    res.status(200).json(await service.removeFromWatchlist(actorId, req.params.slug as string, Number(req.params.malId)));
  } catch (err) { next(err); }
}

export async function getActivity(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.status(200).json(await service.getClubActivity(req.params.slug as string)); }
  catch (err) { next(err); }
}
