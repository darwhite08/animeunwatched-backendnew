import { Request, Response, NextFunction } from "express";
import { updateMeSchema, updateSlugSchema, changeUsernameSchema } from "./users.schema";
import * as service from "./users.service";

export async function getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.getProfile(req.params.username as string, res.locals.user?.id as string | undefined);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function completeOnboarding(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const favoriteGenres = Array.isArray(req.body?.favoriteGenres) ? req.body.favoriteGenres : [];
    res.status(200).json(await service.completeOnboarding(userId, favoriteGenres));
  } catch (err) { next(err); }
}

export async function checkUsernameAvailable(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const username = String(req.query.username ?? "");
    res.status(200).json(await service.checkUsernameAvailable(username, res.locals.user?.id as string | undefined));
  } catch (err) {
    next(err);
  }
}

export async function changeUsername(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const { username } = changeUsernameSchema.parse(req.body);
    const user = await service.changeUsername(userId, username);
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}

const VERIFY_KINDS = ["USER", "CREATOR", "STUDIO"] as const;
export async function setVerification(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = (req.body ?? {}).kind;
    const kind = raw == null || raw === "" || raw === "NONE" ? null : raw;
    if (kind !== null && !VERIFY_KINDS.includes(kind)) {
      res.status(400).json({ error: { code: "BAD_REQUEST", message: "kind must be USER, CREATOR, STUDIO or null" } });
      return;
    }
    const result = await service.setVerification(req.params.username as string, kind);
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
    const result = await service.follow(followerId, req.params.username as string);
    res.status(200).json(result); // { status: "ACCEPTED" | "PENDING" }
  } catch (err) {
    next(err);
  }
}

export async function getFollowRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await service.listFollowRequests(res.locals.user.id as string));
  } catch (err) {
    next(err);
  }
}

export async function acceptFollowRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await service.respondFollowRequest(res.locals.user.id as string, req.params.requesterId as string, true));
  } catch (err) {
    next(err);
  }
}

export async function rejectFollowRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await service.respondFollowRequest(res.locals.user.id as string, req.params.requesterId as string, false));
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

/** GET /users/leaderboard/boards?board=&window=&audience=&limit= — metric boards */
export async function getBoardLeaderboard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const board = String(req.query.board ?? "episodes") as service.BoardId;
    if (!service.BOARD_IDS.includes(board)) {
      res.status(400).json({ error: { code: "VALIDATION", message: "Unknown board" } });
      return;
    }
    const windowQ   = String(req.query.window ?? "all");
    const window    = (["week", "month", "all"].includes(windowQ) ? windowQ : "all") as "week" | "month" | "all";
    const audienceQ = String(req.query.audience ?? "global");
    const audience  = (["global", "friends"].includes(audienceQ) ? audienceQ : "global") as "global" | "friends";
    const limit     = Math.min(100, Number(req.query.limit) || 50);
    const result = await service.getBoardLeaderboard({
      board, window, audience, limit,
      viewerId: res.locals.user?.id as string | undefined,
    });
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
    const userId = res.locals.user.id as string;
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
