import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { adminAudit, ipFromReq, uaFromReq } from "../../lib/adminAudit";

/**
 * M15 — Platform settings as key/value (JSON). Use for things like default
 * tier limits, brand colors, support email — anything that isn't a feature
 * flag and isn't worth its own table.
 */

export async function listSettings(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.adminSetting.findMany({ orderBy: { key: "asc" } });
    res.status(200).json({ data });
  } catch (err) { next(err); }
}

export async function getSetting(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const key = req.params.key as string;
    const row = await prisma.adminSetting.findUnique({ where: { key } });
    if (!row) throw notFound("Setting not found");
    res.status(200).json(row);
  } catch (err) { next(err); }
}

export async function upsertSetting(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const key = req.params.key as string;
    const { value, description } = req.body as { value?: unknown; description?: string };
    if (value === undefined) throw badRequest("value required");
    const existing = await prisma.adminSetting.findUnique({ where: { key } });
    const row = await prisma.adminSetting.upsert({
      where:  { key },
      update: { value: value as never, description, updatedBy: actorId },
      create: { key, value: value as never, description, updatedBy: actorId },
    });
    await adminAudit({
      actorId, action: existing ? "setting.update" : "setting.create",
      targetType: "AdminSetting", targetId: key,
      metadata: { key, before: existing?.value, after: value },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json(row);
  } catch (err) { next(err); }
}

export async function deleteSetting(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const key = req.params.key as string;
    const existing = await prisma.adminSetting.findUnique({ where: { key } });
    if (!existing) throw notFound("Not found");
    await prisma.adminSetting.delete({ where: { key } });
    await adminAudit({
      actorId, action: "setting.delete", targetType: "AdminSetting", targetId: key,
      metadata: { key, before: existing.value },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}
