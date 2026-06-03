import { Request, Response, NextFunction } from "express";
import { updateMeSchema, updateSlugSchema } from "./users.schema";
import * as service from "./users.service";

export async function getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.getProfile(req.params.username as string);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateMe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const dto = updateMeSchema.parse(req.body);
    const result = await service.updateMe(userId, dto);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function follow(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const followerId: string = res.locals.user.id;
    await service.follow(followerId, req.params.username as string);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function unfollow(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const followerId: string = res.locals.user.id;
    await service.unfollow(followerId, req.params.username as string);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function getFollowers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page  = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const result = await service.getFollowers(req.params.username as string, page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getXp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.getXp(req.params.username as string);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getFollowing(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page  = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Number(req.query.limit) || 20);
    const result = await service.getFollowing(req.params.username as string, page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getUserStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.getUserStats(req.params.username as string);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function exportMyData(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const data = await service.exportMyData(userId);
    res.setHeader("Content-Disposition", 'attachment; filename="my-data.json"');
    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
}

export async function getActivity(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(60, Number(req.query.limit) || 20);
    const result = await service.getActivity(req.params.username as string, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getLeaderboard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit  = Math.min(200, Number(req.query.limit) || 50);
    const period = (req.query.period as string) || "all-time";
    const result = await service.getLeaderboard(limit, period);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

// ── Slug management ───────────────────────────────────────────────────────────

/** GET /users/slug-check?slug=foo  — live availability check (no auth needed) */
export async function checkSlugAvailable(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const slug = String(req.query.slug ?? "").trim();
    const result = await service.checkSlugAvailable(slug);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/** PATCH /users/me/slug  — change the authenticated user's routing slug */
export async function updateSlug(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = (req as any).user.id as string;
    const dto    = updateSlugSchema.parse(req.body);
    const user   = await service.updateSlug(userId, dto);
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}

export async function getFollowingActivity(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(20, Number(req.query.limit) || 10);
    const result = await service.getFollowingActivity(req.params.username as string, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getUserPosts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const username = req.params.username as string
    const page  = Number(req.query.page)  || 1
    const limit = Number(req.query.limit) || 20
    const result = await service.getUserPosts(username, page, limit)
    res.status(200).json(result)
  } catch (err) { next(err) }
}

export async function getConnectedAccounts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = res.locals.user?.id as string
    const result = await service.getConnectedAccounts(userId)
    res.status(200).json(result)
  } catch (err) { next(err) }
}

export async function whoToFollow(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const viewerId = res.locals.user.id as string
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10))
    const data = await service.whoToFollow(viewerId, limit)
    res.status(200).json({ data, meta: { algorithm: "who-to-follow-v1", count: data.length } })
  } catch (err) { next(err) }
}
