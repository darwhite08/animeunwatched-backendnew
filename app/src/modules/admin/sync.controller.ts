import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badRequest } from "../../lib/errors";
import { adminAuditR } from "../../lib/adminAudit";
import { SYNC_JOB, enqueueSyncJob, getQueueDepth } from "../anime/syncQueue.service";

// ─── GET /admin/sync/status ──────────────────────────────────────────────────
// Anime sync observability: catalog size, stub count, priority breakdown,
// last-24h SyncJobLog stats and queue depth.

export async function getSyncStatus(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);

    const [totalAnime, stubCount, neverSynced, byPriority, last24h, queue, lastLog] = await Promise.all([
      prisma.anime.count(),
      prisma.anime.count({ where: { isStub: true } }),
      prisma.anime.count({ where: { lastSyncedAt: null } }),
      prisma.anime.groupBy({ by: ["syncPriority"], _count: { _all: true } }),
      prisma.syncJobLog.groupBy({
        by: ["jobType", "status"],
        where: { createdAt: { gte: dayAgo } },
        _count: { _all: true },
        _avg: { durationMs: true },
      }),
      getQueueDepth(),
      prisma.syncJobLog.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    ]);

    res.status(200).json({
      anime: {
        total: totalAnime,
        stubs: stubCount,
        neverSynced,
        byPriority: Object.fromEntries(byPriority.map((p) => [p.syncPriority, p._count._all])),
      },
      queue,
      last24h: last24h.map((r) => ({
        jobType: r.jobType,
        status: r.status,
        count: r._count._all,
        avgDurationMs: r._avg.durationMs ? Math.round(r._avg.durationMs) : null,
      })),
      lastActivityAt: lastLog?.createdAt ?? null,
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /admin/sync/anime/:malId ───────────────────────────────────────────

export async function forceSyncAnime(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = Array.isArray(req.params.malId) ? req.params.malId[0] : req.params.malId;
    const malId = parseInt(raw, 10);
    if (isNaN(malId) || malId <= 0) throw badRequest("malId must be a positive integer");

    const job = await enqueueSyncJob(
      SYNC_JOB.ANIME_FULL,
      { malId },
      { dedupeKey: `${SYNC_JOB.ANIME_FULL}:${malId}`, priority: 10 },
    );
    await adminAuditR(req, res, {
      action: "anime.force_sync", targetType: "Anime", targetId: String(malId),
    });
    res.status(202).json({ enqueued: job !== null, alreadyQueued: job === null });
  } catch (err) {
    next(err);
  }
}

// ─── POST /admin/sync/seed  { fromPage, toPage } ─────────────────────────────

export async function seedTop(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const fromPage = Number(req.body?.fromPage);
    const toPage = Number(req.body?.toPage);
    if (!Number.isInteger(fromPage) || fromPage < 1) throw badRequest("fromPage must be a positive integer");
    if (!Number.isInteger(toPage) || toPage < fromPage) throw badRequest("toPage must be >= fromPage");

    const job = await enqueueSyncJob(
      SYNC_JOB.SEED_TOP,
      { fromPage, toPage },
      { dedupeKey: `${SYNC_JOB.SEED_TOP}:${fromPage}-${toPage}` },
    );
    await adminAuditR(req, res, {
      action: "anime.seed_top", targetType: "SyncJob", targetId: job?.id ?? "deduped",
      metadata: { fromPage, toPage },
    });
    res.status(202).json({ enqueued: job !== null, alreadyQueued: job === null, fromPage, toPage });
  } catch (err) {
    next(err);
  }
}
