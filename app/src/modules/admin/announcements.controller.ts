import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { adminAudit, ipFromReq, uaFromReq } from "../../lib/adminAudit";

/**
 * M14 — Announcements. Drives in-app banners (channel="in_app") or batched
 * emails. publishedAt=null means draft; setting it to now() publishes.
 */

export async function listAnnouncements(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.announcement.findMany({ orderBy: { createdAt: "desc" } });
    res.status(200).json({ data });
  } catch (err) { next(err); }
}

export async function createAnnouncement(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const { title, body, audience, channel, scheduledAt, expiresAt, publish } = req.body as {
      title?: string; body?: string; audience?: string; channel?: string;
      scheduledAt?: string; expiresAt?: string; publish?: boolean;
    };
    if (!title || !body) throw badRequest("title and body required");
    const ann = await prisma.announcement.create({
      data: {
        title, body,
        audience: audience ?? "all",
        channel:  channel ?? "in_app",
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        expiresAt:   expiresAt   ? new Date(expiresAt)   : null,
        publishedAt: publish ? new Date() : null,
        createdBy: actorId,
      },
    });
    await adminAudit({
      actorId, action: publish ? "announcement.publish" : "announcement.create",
      targetType: "Announcement", targetId: ann.id,
      metadata: { title, audience, channel, scheduled: !!scheduledAt },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ announcement: ann });
  } catch (err) { next(err); }
}

export async function publishAnnouncement(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const id = req.params.id as string;
    const ann = await prisma.announcement.findUnique({ where: { id } });
    if (!ann) throw notFound("Not found");
    const updated = await prisma.announcement.update({
      where: { id }, data: { publishedAt: new Date() },
    });
    await adminAudit({
      actorId, action: "announcement.publish", targetType: "Announcement", targetId: id,
      metadata: { title: ann.title },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ announcement: updated });
  } catch (err) { next(err); }
}

export async function deleteAnnouncement(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const id = req.params.id as string;
    const ann = await prisma.announcement.findUnique({ where: { id } });
    if (!ann) throw notFound("Not found");
    await prisma.announcement.delete({ where: { id } });
    await adminAudit({
      actorId, action: "announcement.delete", targetType: "Announcement", targetId: id,
      metadata: { title: ann.title },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}

/** Public endpoint — fetch active announcements for an in-app banner. */
export async function activeAnnouncements(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const now = new Date();
    const data = await prisma.announcement.findMany({
      where: {
        publishedAt: { not: null, lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { publishedAt: "desc" },
      take: 5,
    });
    res.status(200).json({ data });
  } catch (err) { next(err); }
}
