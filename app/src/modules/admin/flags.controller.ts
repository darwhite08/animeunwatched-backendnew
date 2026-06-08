import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { adminAudit, ipFromReq, uaFromReq } from "../../lib/adminAudit";
import { invalidateFlagCache, isEnabled } from "../../lib/featureFlags";
import { broadcastFlagsChanged } from "../../realtime/broadcast";
import { broadcastAdminFlagChanged } from "../../realtime/broadcast";

export async function listFlags(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.featureFlag.findMany({
      orderBy: [{ type: "asc" }, { key: "asc" }],
      include: { _count: { select: { overrides: true } } },
    });
    res.status(200).json({
      data: data.map(f => ({
        id: f.id, key: f.key, description: f.description, type: f.type,
        enabledGlobally: f.enabledGlobally,
        rolloutRules: f.rolloutRules,
        isKillSwitch: f.isKillSwitch,
        killedAt: f.killedAt, killedReason: f.killedReason, killedBy: f.killedBy,
        createdAt: f.createdAt, updatedAt: f.updatedAt,
        overrideCount: f._count.overrides,
      })),
    });
  } catch (err) { next(err); }
}

export async function createFlag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const { key, description, type, enabledGlobally, rolloutRules, isKillSwitch } = req.body as {
      key?: string; description?: string; type?: string; enabledGlobally?: boolean;
      rolloutRules?: Record<string, unknown>; isKillSwitch?: boolean;
    };
    if (!key || !/^[a-z][a-z0-9_.-]*$/.test(key)) throw badRequest("key must be lowercase, alphanumeric/_/-/.");
    const flag = await prisma.featureFlag.create({
      data: {
        key, description: description ?? null,
        type: type ?? "release",
        enabledGlobally: enabledGlobally ?? false,
        rolloutRules: (rolloutRules ?? null) as never,
        isKillSwitch: isKillSwitch ?? false,
        createdBy: actorId,
      },
    });
    invalidateFlagCache(key);
    broadcastFlagsChanged(key);
    await adminAudit({
      actorId, action: "flag.create", targetType: "FeatureFlag", targetId: flag.id,
      metadata: { key, type: flag.type }, ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    broadcastAdminFlagChanged(flag.key, "create", actorId);
    res.status(200).json({ flag });
  } catch (err) { next(err); }
}

export async function updateFlag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const flagId  = req.params.flagId as string;
    const flag = await prisma.featureFlag.findUnique({ where: { id: flagId } });
    if (!flag) throw notFound("Flag not found");
    const { description, type, enabledGlobally, rolloutRules } = req.body as {
      description?: string; type?: string; enabledGlobally?: boolean;
      rolloutRules?: Record<string, unknown> | null;
    };
    const before = { enabledGlobally: flag.enabledGlobally, type: flag.type, rolloutRules: flag.rolloutRules };
    const updated = await prisma.featureFlag.update({
      where: { id: flagId },
      data: {
        ...(description !== undefined ? { description } : {}),
        ...(type        !== undefined ? { type }        : {}),
        ...(enabledGlobally !== undefined ? { enabledGlobally } : {}),
        ...(rolloutRules !== undefined ? { rolloutRules: (rolloutRules ?? null) as never } : {}),
      },
    });
    invalidateFlagCache(flag.key);
    broadcastFlagsChanged(flag.key);
    await adminAudit({
      actorId, action: "flag.update", targetType: "FeatureFlag", targetId: flagId,
      metadata: { before, after: { enabledGlobally: updated.enabledGlobally, type: updated.type, rolloutRules: updated.rolloutRules } },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    broadcastAdminFlagChanged(flag.key, "update", actorId);
    res.status(200).json({ flag: updated });
  } catch (err) { next(err); }
}

export async function killFlag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const flagId  = req.params.flagId as string;
    const { reason } = req.body as { reason?: string };
    const flag = await prisma.featureFlag.findUnique({ where: { id: flagId } });
    if (!flag) throw notFound("Flag not found");
    const updated = await prisma.featureFlag.update({
      where: { id: flagId },
      data: { killedAt: new Date(), killedBy: actorId, killedReason: reason ?? null },
    });
    invalidateFlagCache(flag.key);
    broadcastFlagsChanged(flag.key);
    await adminAudit({
      actorId, action: "flag.kill", targetType: "FeatureFlag", targetId: flagId,
      metadata: { key: flag.key, reason }, ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    broadcastAdminFlagChanged(flag.key, "kill", actorId);
    res.status(200).json({ flag: updated });
  } catch (err) { next(err); }
}

export async function reviveFlag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const flagId  = req.params.flagId as string;
    const flag = await prisma.featureFlag.findUnique({ where: { id: flagId } });
    if (!flag) throw notFound("Flag not found");
    const updated = await prisma.featureFlag.update({
      where: { id: flagId },
      data:  { killedAt: null, killedBy: null, killedReason: null },
    });
    invalidateFlagCache(flag.key);
    broadcastFlagsChanged(flag.key);
    await adminAudit({
      actorId, action: "flag.revive", targetType: "FeatureFlag", targetId: flagId,
      metadata: { key: flag.key }, ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    broadcastAdminFlagChanged(flag.key, "revive", actorId);
    res.status(200).json({ flag: updated });
  } catch (err) { next(err); }
}

export async function deleteFlag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const flagId  = req.params.flagId as string;
    const flag = await prisma.featureFlag.findUnique({ where: { id: flagId } });
    if (!flag) throw notFound("Flag not found");
    await prisma.featureFlag.delete({ where: { id: flagId } });
    invalidateFlagCache(flag.key);
    broadcastFlagsChanged(flag.key);
    await adminAudit({
      actorId, action: "flag.delete", targetType: "FeatureFlag", targetId: flagId,
      metadata: { key: flag.key }, ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    broadcastAdminFlagChanged(flag.key, "delete", actorId);
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}

export async function createOverride(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const flagId  = req.params.flagId as string;
    const { userId, enabled, reason, expiresAt } = req.body as {
      userId?: string; enabled?: boolean; reason?: string; expiresAt?: string;
    };
    if (!userId) throw badRequest("userId required");
    if (enabled === undefined) throw badRequest("enabled required");
    const flag = await prisma.featureFlag.findUnique({ where: { id: flagId } });
    if (!flag) throw notFound("Flag not found");
    const override = await prisma.featureFlagOverride.upsert({
      where:  { flagId_userId: { flagId, userId } },
      update: { enabled, reason, grantedBy: actorId, expiresAt: expiresAt ? new Date(expiresAt) : null },
      create: { flagId, userId, enabled, reason, grantedBy: actorId, expiresAt: expiresAt ? new Date(expiresAt) : null },
    });
    invalidateFlagCache(flag.key);
    broadcastFlagsChanged(flag.key);
    await adminAudit({
      actorId, action: "flag.override", targetType: "FeatureFlag", targetId: flagId,
      metadata: { key: flag.key, userId, enabled, reason },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    broadcastAdminFlagChanged(flag.key, "override", actorId);
    res.status(200).json({ override });
  } catch (err) { next(err); }
}

export async function listOverrides(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const flagId = req.params.flagId as string;
    const data = await prisma.featureFlagOverride.findMany({
      where: { flagId },
      orderBy: { createdAt: "desc" },
    });
    res.status(200).json({ data });
  } catch (err) { next(err); }
}

export async function deleteOverride(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const overrideId = req.params.overrideId as string;
    const ov = await prisma.featureFlagOverride.findUnique({ where: { id: overrideId }, include: { flag: true } });
    if (!ov) throw notFound("Override not found");
    await prisma.featureFlagOverride.delete({ where: { id: overrideId } });
    invalidateFlagCache(ov.flag.key);
    broadcastFlagsChanged(ov.flag.key);
    await adminAudit({
      actorId, action: "flag.override_revoke", targetType: "FeatureFlag", targetId: ov.flagId,
      metadata: { key: ov.flag.key, userId: ov.userId },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}

/** Evaluate a flag for a given user — useful for admin debugging. */
export async function evaluateFlag(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const key    = req.params.key as string;
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
    const value  = await isEnabled(key, { userId });
    res.status(200).json({ key, userId: userId ?? null, enabled: value });
  } catch (err) { next(err); }
}
