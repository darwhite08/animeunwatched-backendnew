import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badRequest, notFound, forbidden } from "../../lib/errors";
import { adminAuditR } from "../../lib/adminAudit";
import { broadcastAdminAlertAcked } from "../../realtime/broadcast";

/**
 * M14 — notification templates. Operators edit subject/body so engineering
 * doesn't have to ship a deploy for copy changes. {{var}} interpolation
 * happens at send-time (renderer not in this module).
 */

export async function listTemplates(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.notificationTemplate.findMany({ orderBy: { key: "asc" } });
    res.status(200).json({ data });
  } catch (err) { next(err); }
}

export async function getTemplate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tpl = await prisma.notificationTemplate.findUnique({ where: { id: req.params.id as string } });
    if (!tpl) throw notFound("Not found");
    res.status(200).json(tpl);
  } catch (err) { next(err); }
}

export async function createTemplate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const { key, channel, subject, body, description } = req.body as {
      key?: string; channel?: string; subject?: string; body?: string; description?: string;
    };
    if (!key || !body) throw badRequest("key and body required");
    const exists = await prisma.notificationTemplate.findUnique({ where: { key } });
    if (exists) throw badRequest(`template '${key}' already exists`);
    const tpl = await prisma.notificationTemplate.create({
      data: { key, channel: channel ?? "in_app", subject, body, description, createdBy: actorId },
    });
    await adminAuditR(req, res, {
      action: "template.create", targetType: "NotificationTemplate", targetId: tpl.id,
      metadata: { key, channel: tpl.channel },
    });
    res.status(200).json({ template: tpl });
  } catch (err) { next(err); }
}

export async function updateTemplate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string;
    const tpl = await prisma.notificationTemplate.findUnique({ where: { id } });
    if (!tpl) throw notFound("Not found");
    const { channel, subject, body, description } = req.body as {
      channel?: string; subject?: string; body?: string; description?: string;
    };
    const updated = await prisma.notificationTemplate.update({
      where: { id },
      data: {
        ...(channel !== undefined ? { channel } : {}),
        ...(subject !== undefined ? { subject } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(description !== undefined ? { description } : {}),
      },
    });
    await adminAuditR(req, res, {
      action: "template.update", targetType: "NotificationTemplate", targetId: id,
      metadata: { key: tpl.key, before: { subject: tpl.subject, body: tpl.body.slice(0, 200) }, after: { subject, body: body?.slice(0, 200) } },
    });
    res.status(200).json({ template: updated });
  } catch (err) { next(err); }
}

export async function deleteTemplate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string;
    const tpl = await prisma.notificationTemplate.findUnique({ where: { id } });
    if (!tpl) throw notFound("Not found");
    if (tpl.isSystem) throw forbidden("Cannot delete system template");
    await prisma.notificationTemplate.delete({ where: { id } });
    await adminAuditR(req, res, {
      action: "template.delete", targetType: "NotificationTemplate", targetId: id,
      metadata: { key: tpl.key },
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}

/** Admin alerts surface — used by Overview "attention" panel. */
export async function listAdminAlerts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const includeAcked = req.query.includeAcked === "true";
    const data = await prisma.adminAlert.findMany({
      where: includeAcked ? {} : { acknowledgedAt: null },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
      take: 50,
    });
    res.status(200).json({ data });
  } catch (err) { next(err); }
}

export async function ackAlert(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const id = req.params.id as string;
    await prisma.adminAlert.update({
      where: { id }, data: { acknowledgedAt: new Date(), acknowledgedBy: actorId },
    });
    await adminAuditR(req, res, {
      action: "alert.ack", targetType: "AdminAlert", targetId: id,
    });
    broadcastAdminAlertAcked(id, actorId);
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}

export async function bulkAckAlerts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const { alertIds } = req.body as { alertIds?: unknown };
    if (!Array.isArray(alertIds) || alertIds.length === 0) {
      res.status(400).json({ error: { code: "BAD_REQUEST", message: "alertIds[] required" } }); return;
    }
    const ids = alertIds.map(String).slice(0, 200);
    const r = await prisma.adminAlert.updateMany({
      where: { id: { in: ids }, acknowledgedAt: null },
      data:  { acknowledgedAt: new Date(), acknowledgedBy: actorId },
    });
    await adminAuditR(req, res, {
      action: "alert.bulk_ack", targetType: "AdminAlert",
      metadata: { requested: ids.length, acknowledged: r.count },
    });
    for (const id of ids) broadcastAdminAlertAcked(id, actorId);
    res.status(200).json({ acknowledged: r.count });
  } catch (err) { next(err); }
}
