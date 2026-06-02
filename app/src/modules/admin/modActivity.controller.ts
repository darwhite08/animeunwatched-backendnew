import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"

/**
 * Moderator activity dashboard. Pulls aggregate stats from the AuditLog
 * to show per-moderator KPIs: items reviewed, decision breakdown, avg
 * time-to-decision, recent activity stream.
 */

const MOD_ACTIONS = [
  "moderation.approved", "moderation.rejected", "moderation.removed",
  "user.ban", "user.unban", "user.shadow_ban", "user.shadow_unban",
  "post.delete", "club.delete",
] as const

export async function getModActivity(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7))
    const since = new Date(Date.now() - days * 86_400_000)

    // Per-moderator action counts
    const rows = await prisma.auditLog.groupBy({
      by: ["actorId", "action"],
      where: { action: { in: [...MOD_ACTIONS] }, createdAt: { gte: since } },
      _count: { _all: true },
    })

    const perMod = new Map<string, { actorId: string; total: number; byAction: Record<string, number> }>()
    for (const r of rows) {
      if (!r.actorId) continue
      const rec = perMod.get(r.actorId) ?? { actorId: r.actorId, total: 0, byAction: {} }
      rec.byAction[r.action] = r._count._all
      rec.total += r._count._all
      perMod.set(r.actorId, rec)
    }

    // Resolve usernames
    const actorIds = Array.from(perMod.keys())
    const users = actorIds.length === 0 ? [] : await prisma.user.findMany({
      where:   { id: { in: actorIds } },
      select:  { id: true, username: true, displayName: true, email: true, avatarUrl: true },
    })
    const userMap = new Map(users.map(u => [u.id, u]))

    const leaderboard = Array.from(perMod.values())
      .map(rec => ({ ...rec, user: userMap.get(rec.actorId) ?? null }))
      .sort((a, b) => b.total - a.total)

    // Recent activity stream — last 50 mod actions
    const recent = await prisma.auditLog.findMany({
      where:   { action: { in: [...MOD_ACTIONS] }, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take:    50,
    })

    // Action totals across the whole window
    const totals: Record<string, number> = {}
    for (const r of rows) totals[r.action] = (totals[r.action] ?? 0) + r._count._all

    res.status(200).json({ days, leaderboard, totals, recent })
  } catch (err) { next(err) }
}

/** Bulk action over multiple moderation queue items. */
export async function bulkModerate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { ids, status, note } = req.body as { ids?: string[]; status?: string; note?: string }
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: { code: "VALIDATION", message: "ids[] required" } }); return
    }
    if (!status || !["APPROVED", "REJECTED", "REMOVED"].includes(status)) {
      res.status(400).json({ error: { code: "VALIDATION", message: "status must be APPROVED|REJECTED|REMOVED" } }); return
    }
    if (ids.length > 200) {
      res.status(400).json({ error: { code: "VALIDATION", message: "max 200 items per bulk" } }); return
    }

    let applied = 0; let skipped = 0
    for (const id of ids) {
      try {
        const item = await prisma.moderationItem.findUnique({ where: { id } })
        if (!item || item.status !== "PENDING") { skipped++; continue }
        await prisma.moderationItem.update({
          where: { id },
          data:  { status, reviewerId: actorId, reviewedAt: new Date(), reviewNote: note ?? null },
        })
        applied++
      } catch { skipped++ }
    }

    // Write a single bulk audit entry (the individual items are already in
    // ModerationItem.reviewerId / reviewedAt, so we don't need N audit rows).
    const { adminAuditR } = await import("../../lib/adminAudit")
    await adminAuditR(req, res, {
      action: `moderation.bulk_${status.toLowerCase()}`,
      metadata: { ids, applied, skipped, note },
    })

    res.status(200).json({ applied, skipped })
  } catch (err) { next(err) }
}
