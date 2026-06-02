import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { adminAuditR } from "../../lib/adminAudit";

/**
 * M7 — generic moderation queue. Source-agnostic: rows can come from
 * user reports, auto-filters, or manual escalation. Each row is reviewed
 * by an operator and given a status transition.
 *
 * Statuses: PENDING → APPROVED | REJECTED | REMOVED
 *   APPROVED = content is fine
 *   REJECTED = content stays but flagged for follow-up
 *   REMOVED  = content should be deleted (operator performs the delete elsewhere)
 */

const STATUSES = ["PENDING","APPROVED","REJECTED","REMOVED"] as const;
type Status = typeof STATUSES[number];

export async function listQueue(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : "PENDING";
    const page   = Math.max(1, Number(req.query.page) || 1);
    const limit  = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

    const where: Record<string, unknown> = {};
    if (STATUSES.includes(status as Status)) where.status = status;

    const [data, total] = await prisma.$transaction([
      prisma.moderationItem.findMany({
        where, orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit, take: limit,
      }),
      prisma.moderationItem.count({ where }),
    ]);
    res.status(200).json({ data, total, page, limit });
  } catch (err) { next(err); }
}

export async function createQueueItem(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { targetType, targetId, reason, source } = req.body as {
      targetType?: string; targetId?: string; reason?: string; source?: string;
    };
    if (!targetType || !targetId || !reason) throw badRequest("targetType, targetId, reason required");
    const item = await prisma.moderationItem.create({
      data: { targetType, targetId, reason, source: source ?? "manual" },
    });
    await adminAuditR(req, res, {
      action: "moderation.enqueue", targetType: "ModerationItem", targetId: item.id,
      metadata: { targetType, contentId: targetId, source },
    });
    res.status(200).json({ item });
  } catch (err) { next(err); }
}

export async function reviewQueueItem(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const id      = req.params.id as string;
    const { status, note } = req.body as { status?: string; note?: string };
    if (!status || !["APPROVED","REJECTED","REMOVED"].includes(status)) {
      throw badRequest("status must be APPROVED|REJECTED|REMOVED");
    }
    const item = await prisma.moderationItem.findUnique({ where: { id } });
    if (!item) throw notFound("Item not found");
    if (item.status !== "PENDING") throw badRequest("Item already reviewed");

    const updated = await prisma.moderationItem.update({
      where: { id },
      data:  { status, reviewerId: actorId, reviewedAt: new Date(), reviewNote: note ?? null },
    });
    await adminAuditR(req, res, {
      action: `moderation.${status.toLowerCase()}`,
      targetType: "ModerationItem", targetId: id,
      metadata: { targetType: item.targetType, contentId: item.targetId, note },
    });
    res.status(200).json({ item: updated });
  } catch (err) { next(err); }
}
