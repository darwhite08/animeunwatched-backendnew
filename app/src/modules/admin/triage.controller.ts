import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { notFound } from "../../lib/errors"

/**
 * One-shot triage payload for the spammer-ban workflow. Pulls everything
 * the admin would otherwise tab-switch between:
 *   - basic user identity
 *   - last 10 admin actions targeting this user (mod history)
 *   - similar accounts by recent IP (last 30d)
 *   - recent posts + comments authored
 *   - active sessions (IP + UA)
 *   - latest anomalies + risk hints
 *   - existing internal notes (pinned first)
 *
 * Read-only; respects existing users:read permission.
 */
export async function getUserTriage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.params.userId as string

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, username: true, displayName: true, role: true, isBanned: true, isShadowBanned: true, bannedReason: true, reputation: true, createdAt: true },
    })
    if (!user) throw notFound("User not found")

    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60_000)

    // Pull IPs this user has authenticated from in the last 30 days
    const recentRefreshTokens = await prisma.refreshToken.findMany({
      where: { userId, createdAt: { gte: since30d } },
      select: { ipAddress: true, userAgent: true, createdAt: true },
      orderBy: { createdAt: "desc" }, take: 50,
    })
    const ipSet = new Set(recentRefreshTokens.map(r => r.ipAddress).filter((v): v is string => !!v))

    // Similar accounts: other userIds that share one of those IPs
    let similarAccounts: Array<{ id: string; username: string; displayName: string; isBanned: boolean; sharedIp: string; ipFirstSeen: Date }> = []
    if (ipSet.size > 0) {
      const others = await prisma.refreshToken.findMany({
        where: { ipAddress: { in: Array.from(ipSet) }, userId: { not: userId }, createdAt: { gte: since30d } },
        select: { userId: true, ipAddress: true, createdAt: true },
        orderBy: { createdAt: "asc" }, take: 200,
      })
      const byUser = new Map<string, { ip: string; first: Date }>()
      for (const r of others) {
        if (!byUser.has(r.userId)) byUser.set(r.userId, { ip: r.ipAddress ?? "", first: r.createdAt })
      }
      if (byUser.size > 0) {
        const users = await prisma.user.findMany({
          where: { id: { in: Array.from(byUser.keys()) } },
          select: { id: true, username: true, displayName: true, isBanned: true },
        })
        similarAccounts = users.map(u => ({ ...u, sharedIp: byUser.get(u.id)?.ip ?? "", ipFirstSeen: byUser.get(u.id)?.first ?? new Date() }))
          .sort((a, b) => Number(b.isBanned) - Number(a.isBanned))   // banned siblings first — strongest signal
      }
    }

    const [modHistory, recentPosts, recentComments, sessions, anomalies, notes] = await Promise.all([
      prisma.auditLog.findMany({
        where: { targetId: userId, targetType: "User", action: { in: ["mod_action_applied","user.ban","user.unban","user.shadow_ban","user.role.set"] } },
        orderBy: { createdAt: "desc" }, take: 10,
      }).catch(() => []),
      prisma.post.findMany({
        where: { authorId: userId },
        orderBy: { createdAt: "desc" }, take: 10,
        select: { id: true, content: true, createdAt: true },
      }).catch(() => []),
      prisma.postComment.findMany({
        where: { authorId: userId },
        orderBy: { createdAt: "desc" }, take: 10,
        select: { id: true, content: true, postId: true, createdAt: true },
      }).catch(() => []),
      prisma.refreshToken.findMany({
        where: { userId, expiresAt: { gte: new Date() } },
        orderBy: { createdAt: "desc" }, take: 10,
        select: { id: true, ipAddress: true, userAgent: true, createdAt: true, expiresAt: true },
      }),
      prisma.anomalyEvent.findMany({
        where: { userId, createdAt: { gte: since30d } },
        orderBy: { createdAt: "desc" }, take: 10,
        select: { id: true, kind: true, severity: true, ipAddress: true, acknowledgedAt: true, createdAt: true, evidence: true },
      }),
      prisma.userNote.findMany({
        where: { userId },
        orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
        take: 10,
      }),
    ])

    // Risk score: composite of (anomaly count) + (shared-IP siblings, weighted by their ban state) + (account age inversely)
    const accountAgeDays = (Date.now() - user.createdAt.getTime()) / (24 * 60 * 60_000)
    const bannedSiblingCount = similarAccounts.filter(s => s.isBanned).length
    const riskScore = Math.min(100, Math.round(
      (anomalies.length * 8) +
      (bannedSiblingCount * 20) +
      (similarAccounts.length * 3) +
      (accountAgeDays < 7 ? 15 : accountAgeDays < 30 ? 5 : 0),
    ))

    res.status(200).json({
      user,
      riskScore,
      similarAccounts,
      ipsSeen: Array.from(ipSet),
      modHistory,
      recentPosts,
      recentComments,
      sessions,
      anomalies,
      notes,
    })
  } catch (err) { next(err) }
}
