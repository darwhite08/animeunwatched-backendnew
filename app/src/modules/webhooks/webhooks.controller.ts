import { Request, Response, NextFunction } from "express";
import { env } from "../../config/env";
import * as webhooksService from "./webhooks.service";
import { sendEmail, weeklyDigestEmail, streakReminderEmail } from "../../lib/email";
import { prisma } from "../../config/prisma";

function verifyCronSecret(req: Request): boolean {
  const secret = req.headers["x-cron-secret"] ?? req.query.secret
  return !env.CRON_SECRET || secret === env.CRON_SECRET
}

/**
 * POST /webhooks/media/shot-normalized — the media-normalization pipeline calls
 * this after producing a loudness-normalized clip. Points the shot at the new
 * file and stamps normalizedAt (idempotent: a second call is a harmless no-op).
 */
export async function shotNormalized(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!verifyCronSecret(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
    const shotId        = String(req.body?.shotId ?? "");
    const originalKey   = String(req.body?.originalKey ?? "");   // raw S3 key the pipeline read
    const normalizedKey = String(req.body?.normalizedKey ?? "");
    if (!normalizedKey || (!shotId && !originalKey)) {
      res.status(400).json({ error: "normalizedKey and (shotId or originalKey) required" }); return;
    }

    const base = (env.S3_PUBLIC_URL || `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com`).replace(/\/$/, "");
    const videoUrl = `${base}/${normalizedKey.replace(/^\//, "")}`;

    // Resolve the shot by id, else by matching the original key against videoUrl
    // (the pipeline knows S3 keys, not our cuid ids).
    const shot = shotId
      ? await prisma.shot.findUnique({ where: { id: shotId }, select: { id: true, normalizedAt: true } })
      : await prisma.shot.findFirst({ where: { videoUrl: { endsWith: originalKey.replace(/^\//, "") } }, select: { id: true, normalizedAt: true } });
    if (!shot) { res.status(404).json({ error: "Shot not found" }); return; }
    if (shot.normalizedAt) { res.json({ ok: true, alreadyNormalized: true }); return; }

    await prisma.shot.update({ where: { id: shot.id }, data: { videoUrl, normalizedAt: new Date() } });
    res.json({ ok: true, shotId: shot.id, videoUrl });
  } catch (err) { next(err); }
}

export async function testWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = res.locals.user?.id ?? "test-user";
    const payload = webhooksService.buildTestPayload("user.registered", userId, { test: true });
    await webhooksService.fireWebhook("user.registered", userId, { test: true });
    res.json({ ok: true, payload });
  } catch (err) {
    next(err);
  }
}

export async function weeklyDigestCron(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!verifyCronSecret(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Get top anime from the past 7 days (by list entries added)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const trending = await prisma.listEntry.groupBy({
      by: ["animeId"],
      where: { createdAt: { gte: sevenDaysAgo } },
      _count: { animeId: true },
      orderBy: { _count: { animeId: "desc" } },
      take: 5,
    });

    const trendingAnimeIds = trending.map(t => t.animeId);
    const trendingAnime = await prisma.anime.findMany({
      where: { id: { in: trendingAnimeIds } },
      select: { id: true, title: true },
    });
    const topAnimeNames = trendingAnimeIds
      .map(id => trendingAnime.find(a => a.id === id)?.title ?? null)
      .filter(Boolean) as string[];

    // Get active users (logged in in the past 30 days) with email notifications enabled
    const activeUsers = await prisma.user.findMany({
      where: {
        lastActiveAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        email: { not: "" },
        isBanned: false,
      },
      select: { id: true, email: true, displayName: true, username: true },
      take: 500, // batch limit per run
    });

    let sent = 0;
    for (const user of activeUsers) {
      const opts = weeklyDigestEmail(user.email, user.displayName, topAnimeNames);
      await sendEmail(opts);
      sent++;
    }

    res.json({ ok: true, sent, trendingAnime: topAnimeNames });
  } catch (err) {
    next(err);
  }
}

export async function streakRemindersCron(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!verifyCronSecret(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    // Users who were active yesterday but NOT today (streak at risk)
    const atRiskUsers = await prisma.user.findMany({
      where: {
        streakDays: { gte: 3 }, // Only remind users who have a streak worth protecting
        lastActiveAt: { gte: twoDaysAgo, lt: yesterday },
        isBanned: false,
        email: { not: "" },
      },
      select: { id: true, email: true, displayName: true, streakDays: true },
      take: 1000,
    });

    let sent = 0;
    for (const user of atRiskUsers) {
      const opts = streakReminderEmail(user.email, user.displayName, user.streakDays);
      await sendEmail(opts);
      sent++;
    }

    res.json({ ok: true, sent, message: `Sent ${sent} streak reminders` });
  } catch (err) {
    next(err);
  }
}
