import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { adminAudit, ipFromReq, uaFromReq } from "../../lib/adminAudit";

/**
 * M7 — Content & moderation. Lets operators page through posts/clubs, remove
 * problematic content, and shadow-ban users (content stays visible to the user
 * themselves but hidden from feeds).
 */

export async function listPosts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const page   = Math.max(1, Number(req.query.page) || 1);
    const limit  = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

    const where: Record<string, unknown> = { deletedAt: null };
    if (search) where.content = { contains: search, mode: "insensitive" };

    const [data, total] = await prisma.$transaction([
      prisma.post.findMany({
        where, orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit, take: limit,
        select: {
          id: true, content: true, createdAt: true,
          // Trending-algorithm override fields so the admin UI can show
          // current boost/penalty and operators can tweak via PATCH /score.
          manualBoost: true, shadowPenalty: true,
          author: { select: { id: true, username: true, displayName: true, isShadowBanned: true } },
          _count: { select: { likes: true, comments: true } },
        },
      }),
      prisma.post.count({ where }),
    ]);
    res.status(200).json({ data, total, page, limit });
  } catch (err) { next(err); }
}

export async function deletePost(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const postId  = req.params.postId as string;
    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) throw notFound("Post not found");
    await prisma.post.update({ where: { id: postId }, data: { deletedAt: new Date() } });
    await adminAudit({
      actorId, action: "post.delete", targetType: "Post", targetId: postId,
      metadata: { authorId: post.authorId, content: post.content?.slice(0, 200) },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}

export async function shadowBanUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const userId  = req.params.userId as string;
    const { reason } = req.body as { reason?: string };
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, isShadowBanned: true } });
    if (!user) throw notFound("User not found");
    if (user.role === "ADMIN") throw badRequest("Cannot shadow-ban an admin");
    await prisma.user.update({ where: { id: userId }, data: { isShadowBanned: true } });
    await adminAudit({
      actorId, action: "user.shadow_ban", targetType: "User", targetId: userId,
      metadata: { reason }, ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}

export async function unshadowBanUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const userId  = req.params.userId as string;
    await prisma.user.update({ where: { id: userId }, data: { isShadowBanned: false } });
    await adminAudit({
      actorId, action: "user.shadow_unban", targetType: "User", targetId: userId,
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}

export async function listClubs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const page   = Math.max(1, Number(req.query.page) || 1);
    const limit  = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const where: Record<string, unknown> = {};
    if (search) where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { slug: { contains: search, mode: "insensitive" } },
    ];
    const [data, total] = await prisma.$transaction([
      prisma.club.findMany({
        where, orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit, take: limit,
        select: {
          id: true, name: true, slug: true, description: true, createdAt: true,
          owner: { select: { id: true, username: true, displayName: true } },
          _count: { select: { members: true, threads: true } },
        },
      }),
      prisma.club.count({ where }),
    ]);
    res.status(200).json({ data, total, page, limit });
  } catch (err) { next(err); }
}

export async function deleteClub(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const clubId  = req.params.clubId as string;
    const club = await prisma.club.findUnique({ where: { id: clubId } });
    if (!club) throw notFound("Club not found");
    await prisma.club.delete({ where: { id: clubId } });
    await adminAudit({
      actorId, action: "club.delete", targetType: "Club", targetId: clubId,
      metadata: { name: club.name, slug: club.slug, ownerId: club.ownerId },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}
