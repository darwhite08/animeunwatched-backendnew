import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badRequest, notFound, forbidden } from "../../lib/errors";
import { adminAuditR } from "../../lib/adminAudit";

/**
 * Reverse a recent admin action using its AuditLog row. Only specific actions
 * are undoable — undoing a "user.delete" doesn't restore content, so we
 * whitelist what we support and reject the rest with a clear message.
 *
 * Each undo writes a NEW audit row tagged with `undoOf` so the original
 * action and its reversal are both traceable.
 */

const UNDOABLE_ACTIONS = new Set([
  "user.ban", "user.unban", "user.bulk.ban", "user.bulk.unban",
  "user.update",
  "role.grant", "role.revoke",
  "flag.kill", "flag.revive",
  "user.shadow_ban", "user.shadow_unban",
  "user.role",
] as const);

const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;  // 24h

export async function getUndoable(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - UNDO_WINDOW_MS);
    const rows = await prisma.auditLog.findMany({
      where: {
        action:    { in: Array.from(UNDOABLE_ACTIONS) },
        createdAt: { gte: cutoff },
      },
      orderBy: { createdAt: "desc" },
      take:    100,
    });
    res.status(200).json({ data: rows });
  } catch (err) { next(err); }
}

export async function undoAction(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auditId = req.params.auditId as string;
    const row = await prisma.auditLog.findUnique({ where: { id: auditId } });
    if (!row) throw notFound("Audit entry not found");
    if (!UNDOABLE_ACTIONS.has(row.action as never)) {
      throw badRequest(`Action '${row.action}' is not undoable`);
    }
    if (Date.now() - row.createdAt.getTime() > UNDO_WINDOW_MS) {
      throw forbidden("Undo window (24h) has passed for this action");
    }

    const meta = (row.metadata as Record<string, unknown> | null) ?? {};

    switch (row.action) {
      case "user.ban":
      case "user.bulk.ban": {
        if (!row.targetId) throw badRequest("Original action missing targetId");
        await prisma.user.update({ where: { id: row.targetId }, data: { isBanned: false, bannedReason: null } });
        break;
      }
      case "user.unban":
      case "user.bulk.unban": {
        if (!row.targetId) throw badRequest("Original action missing targetId");
        const prevReason = typeof meta.reason === "string" ? meta.reason : null;
        await prisma.user.update({ where: { id: row.targetId }, data: { isBanned: true, bannedReason: prevReason } });
        break;
      }
      case "user.update": {
        if (!row.targetId) throw badRequest("Original action missing targetId");
        const before = meta.before as Record<string, unknown> | undefined;
        if (!before) throw badRequest("Before state not captured");
        await prisma.user.update({
          where: { id: row.targetId },
          data: {
            ...(typeof before.displayName === "string" ? { displayName: before.displayName } : {}),
            ...(typeof before.bio === "string" || before.bio === null ? { bio: before.bio as string | null } : {}),
            ...(typeof before.reputation === "number" ? { reputation: before.reputation } : {}),
          },
        });
        break;
      }
      case "user.role": {
        if (!row.targetId) throw badRequest("Original action missing targetId");
        const previousRole = (meta.previousRole as "USER"|"MOD"|"ADMIN") ?? "USER";
        await prisma.user.update({ where: { id: row.targetId }, data: { role: previousRole } });
        break;
      }
      case "role.grant": {
        if (!row.targetId) throw badRequest("Original action missing targetId");
        const roleName = meta.roleName as string | undefined;
        if (!roleName) throw badRequest("roleName missing");
        const role = await prisma.adminRole.findUnique({ where: { name: roleName } });
        if (role) await prisma.userAdminRole.deleteMany({ where: { userId: row.targetId, roleId: role.id } });
        break;
      }
      case "role.revoke": {
        if (!row.targetId) throw badRequest("Original action missing targetId");
        const roleName = meta.roleName as string | undefined;
        if (!roleName) throw badRequest("roleName missing");
        const role = await prisma.adminRole.findUnique({ where: { name: roleName } });
        if (role) {
          await prisma.userAdminRole.upsert({
            where:  { userId_roleId: { userId: row.targetId, roleId: role.id } },
            update: {},
            create: { userId: row.targetId, roleId: role.id, grantedBy: row.actorId },
          });
        }
        break;
      }
      case "flag.kill": {
        if (!row.targetId) throw badRequest("Original action missing targetId");
        await prisma.featureFlag.update({
          where: { id: row.targetId },
          data:  { killedAt: null, killedBy: null, killedReason: null },
        });
        break;
      }
      case "flag.revive": {
        if (!row.targetId) throw badRequest("Original action missing targetId");
        await prisma.featureFlag.update({
          where: { id: row.targetId },
          data:  { killedAt: new Date(), killedBy: res.locals.user?.id ?? null, killedReason: "undo of revive" },
        });
        break;
      }
      case "user.shadow_ban": {
        if (!row.targetId) throw badRequest("Original action missing targetId");
        await prisma.user.update({ where: { id: row.targetId }, data: { isShadowBanned: false } });
        break;
      }
      case "user.shadow_unban": {
        if (!row.targetId) throw badRequest("Original action missing targetId");
        await prisma.user.update({ where: { id: row.targetId }, data: { isShadowBanned: true } });
        break;
      }
      default:
        throw badRequest(`Action '${row.action}' is not undoable`);
    }

    await adminAuditR(req, res, {
      action:     `undo.${row.action}`,
      targetType: row.targetType,
      targetId:   row.targetId,
      metadata:   { undoOf: row.id, originalActorId: row.actorId, originalAt: row.createdAt.toISOString() },
    });

    res.status(200).json({ ok: true, undoOf: row.id });
  } catch (err) { next(err); }
}
