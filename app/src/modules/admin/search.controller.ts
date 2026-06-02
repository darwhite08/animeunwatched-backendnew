import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";

/**
 * Global search for the admin command palette (⌘K).
 *
 * Multi-source. Each section returns ≤ 5 rows so the palette stays snappy.
 * Sources: users, posts, audit log, feature flags, settings, admin roles.
 *
 * Not audited — search results don't reveal anything the per-domain reads
 * wouldn't, and the palette can fire often.
 */
export async function globalSearch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length < 2) {
      res.status(200).json({ q, results: { users: [], posts: [], audit: [], flags: [], settings: [], roles: [] } });
      return;
    }
    const like = { contains: q, mode: "insensitive" as const };

    const [users, posts, audit, flags, settings, roles] = await Promise.all([
      prisma.user.findMany({
        where: { OR: [{ username: like }, { displayName: like }, { email: like }] },
        select: { id: true, username: true, displayName: true, email: true, avatarUrl: true, isBanned: true, role: true },
        take: 5,
      }),
      prisma.post.findMany({
        where: { content: like, deletedAt: null },
        select: { id: true, content: true, createdAt: true, author: { select: { username: true } } },
        take: 5,
        orderBy: { createdAt: "desc" },
      }),
      prisma.auditLog.findMany({
        where: { OR: [{ action: like }, { actorId: like }, { targetId: like }] },
        select: { id: true, action: true, actorId: true, targetType: true, targetId: true, createdAt: true },
        take: 5,
        orderBy: { createdAt: "desc" },
      }),
      prisma.featureFlag.findMany({
        where: { OR: [{ key: like }, { description: like }] },
        select: { id: true, key: true, type: true, enabledGlobally: true, killedAt: true },
        take: 5,
      }),
      prisma.adminSetting.findMany({
        where: { OR: [{ key: like }, { description: like }] },
        select: { key: true, description: true, updatedAt: true },
        take: 5,
      }),
      prisma.adminRole.findMany({
        where: { OR: [{ name: like }, { description: like }] },
        select: { id: true, name: true, description: true, isSystem: true },
        take: 5,
      }),
    ]);

    res.status(200).json({ q, results: { users, posts, audit, flags, settings, roles } });
  } catch (err) { next(err); }
}
