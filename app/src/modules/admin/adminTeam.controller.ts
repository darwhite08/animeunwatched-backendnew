import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";

/**
 * M15 — admin-team management. Lists every user that holds at least one
 * admin role (or has the legacy User.role=ADMIN flag), with their roles,
 * last login time, and a "last reviewed" marker for access reviews.
 *
 * The "review" record lives in AdminSetting under key `adminTeam.lastReview`
 * which stores `{ [userId]: ISOTimestamp }`.
 */

export async function listAdminTeam(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const [usersByRole, legacyAdmins, reviewSetting] = await Promise.all([
      prisma.userAdminRole.findMany({
        include: {
          role: { select: { name: true } },
        },
      }),
      prisma.user.findMany({
        where:  { role: "ADMIN" },
        select: { id: true, email: true, username: true, displayName: true,
                  avatarUrl: true, isBanned: true, lastActiveAt: true, createdAt: true },
      }),
      prisma.adminSetting.findUnique({ where: { key: "adminTeam.lastReview" } }),
    ]);

    const reviews = (reviewSetting?.value as Record<string, string> | undefined) ?? {};

    // Build per-user role list
    const rolesByUser = new Map<string, string[]>();
    for (const r of usersByRole) {
      const arr = rolesByUser.get(r.userId) ?? [];
      arr.push(r.role.name);
      rolesByUser.set(r.userId, arr);
    }

    // Fetch user records for anyone who has admin roles but isn't User.role=ADMIN
    const knownIds = new Set(legacyAdmins.map(u => u.id));
    const extraIds = [...rolesByUser.keys()].filter(id => !knownIds.has(id));
    const extras = extraIds.length === 0 ? [] : await prisma.user.findMany({
      where:  { id: { in: extraIds } },
      select: { id: true, email: true, username: true, displayName: true,
                avatarUrl: true, isBanned: true, lastActiveAt: true, createdAt: true },
    });

    const all = [...legacyAdmins, ...extras];
    const data = all.map(u => ({
      ...u,
      adminRoles:   rolesByUser.get(u.id) ?? (u.id ? ["LegacyAdmin"] : []),
      lastReviewAt: reviews[u.id] ?? null,
    }));
    res.status(200).json({ data });
  } catch (err) { next(err); }
}

export async function markReviewed(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const userId  = req.params.userId as string;
    const existing = await prisma.adminSetting.findUnique({ where: { key: "adminTeam.lastReview" } });
    const reviews = (existing?.value as Record<string, string> | undefined) ?? {};
    reviews[userId] = new Date().toISOString();
    await prisma.adminSetting.upsert({
      where:  { key: "adminTeam.lastReview" },
      update: { value: reviews as never, updatedBy: actorId },
      create: { key: "adminTeam.lastReview", value: reviews as never, updatedBy: actorId,
                description: "Access-review timestamps per admin user" },
    });
    res.status(200).json({ ok: true, reviewedAt: reviews[userId] });
  } catch (err) { next(err); }
}
