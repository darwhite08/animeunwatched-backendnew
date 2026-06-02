import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { verifyAdminAuditChain, adminAuditR } from "../../lib/adminAudit";

/**
 * Lists the AuditLog with optional filters. Read access requires
 * permission `audit:read` (enforced at the route layer).
 *
 * Filters: actor, action prefix, targetType, targetId, from, to.
 */
export async function listAuditLog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page    = Math.max(1, Number(req.query.page)  || 1);
    const limit   = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const actorId = typeof req.query.actor      === "string" ? req.query.actor      : undefined;
    const action  = typeof req.query.action     === "string" ? req.query.action     : undefined;
    const target  = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const tId     = typeof req.query.targetId   === "string" ? req.query.targetId   : undefined;
    const from    = typeof req.query.from       === "string" ? new Date(req.query.from) : undefined;
    const to      = typeof req.query.to         === "string" ? new Date(req.query.to)   : undefined;

    const where: Record<string, unknown> = {};
    if (actorId) where.actorId    = actorId;
    if (action)  where.action     = { startsWith: action };
    if (target)  where.targetType = target;
    if (tId)     where.targetId   = tId;
    if (from || to) {
      where.createdAt = {
        ...(from && !isNaN(from.getTime())  ? { gte: from } : {}),
        ...(to   && !isNaN(to.getTime())    ? { lte: to }   : {}),
      };
    }

    const skip = (page - 1) * limit;
    const [data, total] = await prisma.$transaction([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip, take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);

    // Per spec M8: "viewing audit logs is itself audited"
    await adminAuditR(req, res, {
      action: "audit.viewed",
      metadata: { filters: { actorId, action, target, tId, from: from?.toISOString(), to: to?.toISOString() }, page, limit, count: data.length },
    });

    res.status(200).json({ data, total, page, limit });
  } catch (err) { next(err); }
}

/** CSV export — capped at 10k rows. */
export async function exportAuditLog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = typeof req.query.actor      === "string" ? req.query.actor      : undefined;
    const action  = typeof req.query.action     === "string" ? req.query.action     : undefined;
    const target  = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const from    = typeof req.query.from       === "string" ? new Date(req.query.from) : undefined;
    const to      = typeof req.query.to         === "string" ? new Date(req.query.to)   : undefined;

    const where: Record<string, unknown> = {};
    if (actorId) where.actorId    = actorId;
    if (action)  where.action     = { startsWith: action };
    if (target)  where.targetType = target;
    if (from || to) {
      where.createdAt = {
        ...(from && !isNaN(from.getTime())  ? { gte: from } : {}),
        ...(to   && !isNaN(to.getTime())    ? { lte: to }   : {}),
      };
    }

    const rows = await prisma.auditLog.findMany({
      where, orderBy: { createdAt: "desc" }, take: 10_000,
    });

    // Per spec M8: viewing/exporting audit is itself audited.
    await adminAuditR(req, res, {
      action: "audit.exported",
      metadata: { filters: { actorId, action, target, from: from?.toISOString(), to: to?.toISOString() }, exportedRows: rows.length },
    });

    const escape = (v: unknown): string => {
      const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = ["createdAt","action","actorId","impersonatorId","targetType","targetId","metadata","ipAddress","userAgent","integrityHash"];
    const csv = [
      header.join(","),
      ...rows.map(r => [
        r.createdAt.toISOString(), r.action, r.actorId, r.impersonatorId,
        r.targetType, r.targetId, r.metadata, r.ipAddress, r.userAgent, r.integrityHash,
      ].map(escape).join(",")),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="audit-${Date.now()}.csv"`);
    res.status(200).send(csv);
  } catch (err) { next(err); }
}

/** Verify the integrity hash chain — operational health check. */
export async function verifyAuditChain(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await verifyAdminAuditChain();
    if (result) res.status(200).json({ intact: false, brokenAt: result.brokenAt });
    else        res.status(200).json({ intact: true });
  } catch (err) { next(err); }
}
