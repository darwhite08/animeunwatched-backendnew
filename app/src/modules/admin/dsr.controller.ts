import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { notFound } from "../../lib/errors";
import { adminAudit, ipFromReq, uaFromReq } from "../../lib/adminAudit";

/**
 * M10 — Data Subject Requests. Export: aggregate all of a user's data into
 * a single JSON file. Delete: hard-delete user + cascade content.
 *
 * Both endpoints require step-up at the route layer (DSR is high-risk).
 */

export async function exportUserData(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const userId  = req.params.userId as string;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound("User not found");

    const [
      posts, comments, reviews, blogs, listEntries, threads, replies,
      activities, follows, notifications, conversations, devices, securityEvents,
    ] = await Promise.all([
      prisma.post.findMany({ where: { authorId: userId } }),
      prisma.postComment.findMany({ where: { authorId: userId } }),
      prisma.review.findMany({ where: { authorId: userId } }),
      prisma.blog.findMany({ where: { authorId: userId } }),
      prisma.listEntry.findMany({ where: { userId } }),
      prisma.thread.findMany({ where: { authorId: userId } }),
      prisma.threadReply.findMany({ where: { authorId: userId } }),
      prisma.activity.findMany({ where: { authorId: userId } }),
      prisma.follow.findMany({ where: { OR: [{ followerId: userId }, { followingId: userId }] } }),
      prisma.notification.findMany({ where: { recipientId: userId } }),
      prisma.conversation.findMany({ where: { OR: [{ participant1: userId }, { participant2: userId }] } }),
      prisma.deviceToken.findMany({ where: { userId } }),
      prisma.securityEvent.findMany({ where: { userId } }),
    ]);

    const exported = {
      exportedAt:   new Date().toISOString(),
      exportedBy:   actorId,
      user:         { ...user, passwordHash: "[REDACTED]" },
      posts, comments, reviews, blogs, listEntries, threads, replies,
      activities, follows, notifications, conversations, devices, securityEvents,
    };

    await adminAudit({
      actorId, action: "dsr.export", targetType: "User", targetId: userId,
      metadata: { recordCounts: {
        posts: posts.length, comments: comments.length, reviews: reviews.length,
        blogs: blogs.length, listEntries: listEntries.length, threads: threads.length,
        replies: replies.length, activities: activities.length, follows: follows.length,
        notifications: notifications.length, conversations: conversations.length,
        devices: devices.length, securityEvents: securityEvents.length,
      } },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="dsr-${userId}-${Date.now()}.json"`);
    res.status(200).send(JSON.stringify(exported, null, 2));
  } catch (err) { next(err); }
}

/**
 * Preview what an export would contain — record counts only, no PII bodies.
 * Used by the admin UI to confirm scope before the actual export runs.
 * No step-up required (read-only counts), but still gated by dsr:export
 * at the route layer.
 */
export async function previewUserData(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.params.userId as string
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, username: true, displayName: true, createdAt: true, isBanned: true },
    })
    if (!user) throw notFound("User not found")

    const [posts, comments, reviews, blogs, listEntries, threads, replies, activities, follows, notifications, conversations, devices, securityEvents] = await Promise.all([
      prisma.post.count({ where: { authorId: userId } }),
      prisma.postComment.count({ where: { authorId: userId } }),
      prisma.review.count({ where: { authorId: userId } }),
      prisma.blog.count({ where: { authorId: userId } }),
      prisma.listEntry.count({ where: { userId } }),
      prisma.thread.count({ where: { authorId: userId } }),
      prisma.threadReply.count({ where: { authorId: userId } }),
      prisma.activity.count({ where: { authorId: userId } }),
      prisma.follow.count({ where: { OR: [{ followerId: userId }, { followingId: userId }] } }),
      prisma.notification.count({ where: { recipientId: userId } }),
      prisma.conversation.count({ where: { OR: [{ participant1: userId }, { participant2: userId }] } }),
      prisma.deviceToken.count({ where: { userId } }),
      prisma.securityEvent.count({ where: { userId } }),
    ])

    const total = posts + comments + reviews + blogs + listEntries + threads + replies + activities + follows + notifications + conversations + devices + securityEvents

    res.status(200).json({
      user,
      total,
      counts: { posts, comments, reviews, blogs, listEntries, threads, replies, activities, follows, notifications, conversations, devices, securityEvents },
    })
  } catch (err) { next(err) }
}

/** Recent DSR audit log entries (export + delete) so the admin UI can show a receipt feed. */
export async function listRecentDsr(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.auditLog.findMany({
      where: { action: { in: ["dsr.export", "dsr.delete"] } },
      orderBy: { createdAt: "desc" }, take: 25,
      select: { id: true, action: true, actorId: true, targetId: true, metadata: true, createdAt: true, ipAddress: true },
    })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

/**
 * Hard-delete the user and cascade. Relations with onDelete: Cascade clean
 * themselves; others are SetNull or deleted explicitly. This is irreversible
 * — operator must pass step-up.
 */
export async function deleteUserData(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const userId  = req.params.userId as string;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound("User not found");

    // Capture summary BEFORE deletion (the AuditLog write happens with referential
    // integrity to the User row gone — actorId is the operator, targetId is the
    // user id captured here for audit history).
    const summary = {
      email: user.email, username: user.username, role: user.role,
      hadAvatar: !!user.avatarUrl,
    };

    await prisma.user.delete({ where: { id: userId } });

    await adminAudit({
      actorId, action: "dsr.delete", targetType: "User", targetId: userId,
      metadata: { summary },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}
