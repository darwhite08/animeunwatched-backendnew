import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { adminAudit, ipFromReq, uaFromReq } from "../../lib/adminAudit";

export async function listEntitlements(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId  = typeof req.query.userId  === "string" ? req.query.userId  : undefined;
    const feature = typeof req.query.feature === "string" ? req.query.feature : undefined;
    const page    = Math.max(1, Number(req.query.page) || 1);
    const limit   = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const where: Record<string, unknown> = {};
    if (userId)  where.userId  = userId;
    if (feature) where.feature = feature;
    const [data, total] = await prisma.$transaction([
      prisma.entitlement.findMany({
        where, orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit, take: limit,
      }),
      prisma.entitlement.count({ where }),
    ]);
    res.status(200).json({ data, total, page, limit });
  } catch (err) { next(err); }
}

export async function grantEntitlement(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const { userId, feature, limit, source, expiresAt, reason } = req.body as {
      userId?: string; feature?: string; limit?: number; source?: string;
      expiresAt?: string; reason?: string;
    };
    if (!userId || !feature) throw badRequest("userId and feature required");
    const ent = await prisma.entitlement.upsert({
      where:  { userId_feature: { userId, feature } },
      update: {
        limit: limit ?? null, source: source ?? "manual",
        expiresAt: expiresAt ? new Date(expiresAt) : null, reason, grantedBy: actorId,
      },
      create: {
        userId, feature, limit: limit ?? null, source: source ?? "manual",
        expiresAt: expiresAt ? new Date(expiresAt) : null, reason, grantedBy: actorId,
      },
    });
    await adminAudit({
      actorId, action: "entitlement.grant", targetType: "Entitlement", targetId: ent.id,
      metadata: { userId, feature, limit, source: source ?? "manual" },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ entitlement: ent });
  } catch (err) { next(err); }
}

export async function revokeEntitlement(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const id = req.params.id as string;
    const ent = await prisma.entitlement.findUnique({ where: { id } });
    if (!ent) throw notFound("Entitlement not found");
    await prisma.entitlement.delete({ where: { id } });
    await adminAudit({
      actorId, action: "entitlement.revoke", targetType: "Entitlement", targetId: id,
      metadata: { userId: ent.userId, feature: ent.feature },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}
