import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { adminAudit, ipFromReq, uaFromReq } from "../../lib/adminAudit";

/**
 * M12 — Outbound webhook endpoint config + delivery log.
 * Replay creates a new WebhookDelivery row pointing to the same eventId.
 * Actual delivery dispatch (HTTP POST) lives in a separate worker — this
 * module is the admin-CRUD surface.
 */

export async function listEndpoints(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.webhookEndpoint.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true, url: true, events: true, enabled: true, description: true,
        createdAt: true, updatedAt: true,
      },
    });
    res.status(200).json({ data });
  } catch (err) { next(err); }
}

export async function createEndpoint(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const { url, events, description } = req.body as {
      url?: string; events?: string[]; description?: string;
    };
    if (!url || !/^https?:\/\//.test(url)) throw badRequest("url (http/https) required");
    if (!Array.isArray(events) || events.length === 0) throw badRequest("events[] required");
    const secret = crypto.randomBytes(32).toString("base64url");
    const ep = await prisma.webhookEndpoint.create({
      data: {
        url, events: events as never, secret, description: description ?? null,
        createdBy: actorId,
      },
    });
    await adminAudit({
      actorId, action: "webhook.create", targetType: "WebhookEndpoint", targetId: ep.id,
      metadata: { url, events },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    // Return secret ONCE
    res.status(200).json({ endpoint: ep, secret });
  } catch (err) { next(err); }
}

export async function updateEndpoint(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const id = req.params.endpointId as string;
    const ep = await prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!ep) throw notFound("Endpoint not found");
    const { url, events, enabled, description } = req.body as {
      url?: string; events?: string[]; enabled?: boolean; description?: string;
    };
    const updated = await prisma.webhookEndpoint.update({
      where: { id },
      data: {
        ...(url !== undefined ? { url } : {}),
        ...(Array.isArray(events) ? { events: events as never } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(description !== undefined ? { description } : {}),
      },
    });
    await adminAudit({
      actorId, action: "webhook.update", targetType: "WebhookEndpoint", targetId: id,
      metadata: { url, events, enabled },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ endpoint: updated });
  } catch (err) { next(err); }
}

export async function deleteEndpoint(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const id = req.params.endpointId as string;
    const ep = await prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!ep) throw notFound("Endpoint not found");
    await prisma.webhookEndpoint.delete({ where: { id } });
    await adminAudit({
      actorId, action: "webhook.delete", targetType: "WebhookEndpoint", targetId: id,
      metadata: { url: ep.url },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}

export async function listDeliveries(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const endpointId = typeof req.query.endpointId === "string" ? req.query.endpointId : undefined;
    const failed     = req.query.failed === "true";
    const page       = Math.max(1, Number(req.query.page) || 1);
    const limit      = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const where: Record<string, unknown> = {};
    if (endpointId) where.endpointId = endpointId;
    if (failed)     where.succeededAt = null;
    const [data, total] = await prisma.$transaction([
      prisma.webhookDelivery.findMany({
        where, orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit, take: limit,
      }),
      prisma.webhookDelivery.count({ where }),
    ]);
    res.status(200).json({ data, total, page, limit });
  } catch (err) { next(err); }
}

export async function replayDelivery(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const id = req.params.deliveryId as string;
    const original = await prisma.webhookDelivery.findUnique({ where: { id } });
    if (!original) throw notFound("Delivery not found");
    const newDelivery = await prisma.webhookDelivery.create({
      data: {
        endpointId:    original.endpointId,
        eventName:     original.eventName,
        eventId:       original.eventId,
        payload:       original.payload as never,
        // Actual HTTP retry handled by worker — admin replay just enqueues a new attempt.
        attempts: 0,
      },
    });
    await adminAudit({
      actorId, action: "webhook.replay", targetType: "WebhookDelivery", targetId: id,
      metadata: { newDeliveryId: newDelivery.id, eventId: original.eventId },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ ok: true, newDeliveryId: newDelivery.id });
  } catch (err) { next(err); }
}
