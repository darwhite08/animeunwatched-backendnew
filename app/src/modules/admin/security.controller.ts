import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badRequest } from "../../lib/errors";
import { adminAuditR } from "../../lib/adminAudit";

/**
 * M10 — security policies stored in AdminSetting under the "security.*" prefix.
 *
 * Recognized keys (all optional, sensible defaults applied on read):
 *   security.mfaRequired      boolean      default false
 *   security.passwordMinLen   number       default 8
 *   security.sessionTtlMin    number       default 60 * 24   (1 day in min)
 *   security.ipAllowList      string[]     default []
 *   security.dataRetentionDays { audit: number; sessions: number; ... }
 *   security.sso              { provider: "saml"|"oidc"|null; metadataUrl?: string }
 */

const POLICY_KEYS = [
  "security.mfaRequired",
  "security.passwordMinLen",
  "security.sessionTtlMin",
  "security.ipAllowList",
  "security.dataRetentionDays",
  "security.sso",
] as const;

const DEFAULTS: Record<string, unknown> = {
  "security.mfaRequired":       false,
  "security.passwordMinLen":    8,
  "security.sessionTtlMin":     1440,
  "security.ipAllowList":       [],
  "security.dataRetentionDays": { audit: 365, sessions: 90, securityEvents: 365 },
  "security.sso":               { provider: null },
};

export async function getPolicies(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.adminSetting.findMany({
      where: { key: { in: [...POLICY_KEYS] } },
    });
    const result: Record<string, unknown> = { ...DEFAULTS };
    for (const r of rows) result[r.key] = r.value;
    res.status(200).json({ data: result });
  } catch (err) { next(err); }
}

export async function setPolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const { key, value } = req.body as { key?: string; value?: unknown };
    if (!key || !POLICY_KEYS.includes(key as typeof POLICY_KEYS[number])) {
      throw badRequest(`unknown policy key. Allowed: ${POLICY_KEYS.join(", ")}`);
    }
    if (value === undefined) throw badRequest("value required");

    const existing = await prisma.adminSetting.findUnique({ where: { key } });
    await prisma.adminSetting.upsert({
      where:  { key },
      update: { value: value as never, updatedBy: actorId },
      create: { key, value: value as never, updatedBy: actorId },
    });
    await adminAuditR(req, res, {
      action: "security.policy_update", targetType: "AdminSetting", targetId: key,
      metadata: { key, before: existing?.value ?? DEFAULTS[key], after: value },
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}

/** List SecurityEvent (the existing end-user auth event log) with filters. */
export async function listSecurityEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const type    = typeof req.query.type === "string" ? req.query.type : undefined;
    const userId  = typeof req.query.userId === "string" ? req.query.userId : undefined;
    const since   = typeof req.query.since === "string" ? new Date(req.query.since) : undefined;
    const page    = Math.max(1, Number(req.query.page) || 1);
    const limit   = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const where: Record<string, unknown> = {};
    if (type)   where.type   = type;
    if (userId) where.userId = userId;
    if (since && !isNaN(since.getTime())) where.createdAt = { gte: since };

    const [data, total] = await prisma.$transaction([
      prisma.securityEvent.findMany({
        where, orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit, take: limit,
        include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true } } },
      }),
      prisma.securityEvent.count({ where }),
    ]);

    await adminAuditR(req, res, {
      action: "security.events_viewed",
      metadata: { filters: { type, userId, since: since?.toISOString() }, page, limit, count: data.length },
    });

    res.status(200).json({ data, total, page, limit });
  } catch (err) { next(err); }
}

/**
 * Public read so other code (auth middleware, password validators) can
 * consult the current policy without re-loading the table.
 */
export async function getSecurityPolicyValue<T = unknown>(key: typeof POLICY_KEYS[number], fallback: T): Promise<T> {
  const row = await prisma.adminSetting.findUnique({ where: { key } });
  return (row?.value as T | undefined) ?? fallback;
}
