/**
 * Postgres-backed sync job queue.
 *
 * The repo intentionally has no Redis/BullMQ (see lib/jobRegistry.ts), so
 * durable queue state lives in the SyncJob table: enqueues survive restarts
 * (a multi-hour seed keeps its place across deploys) and the in-process
 * worker (jobs/animeSync.worker.ts) drains it at the Jikan rate limit.
 */
import { prisma } from "../../config/prisma";

export const SYNC_JOB = {
  ANIME_FULL: "sync-anime-full",
  EPISODES: "sync-episodes",
  SEED_TOP: "seed-top",
  /** Walks the COMPLETE /anime catalog (~30k entries) ordered by mal_id. */
  SEED_ALL: "seed-all",
  SEED_SEASON: "seed-season",
  REFRESH_HOT: "refresh-hot",
  REFRESH_NORMAL: "refresh-normal",
  REFRESH_COLD: "refresh-cold",
  // ── Manga (same queue, same drain loop; handlers in modules/manga) ──
  MANGA_FULL: "sync-manga-full",
  SEED_TOP_MANGA: "seed-top-manga",
  /** Walks the COMPLETE /manga catalog ordered by mal_id (includes classics + BL). */
  SEED_ALL_MANGA: "seed-manga-all",
  REFRESH_MANGA_HOT: "refresh-manga-hot",
  REFRESH_MANGA_NORMAL: "refresh-manga-normal",
  REFRESH_MANGA_COLD: "refresh-manga-cold",
} as const;

export type SyncJobType = (typeof SYNC_JOB)[keyof typeof SYNC_JOB];

export interface SyncJobRow {
  id: string;
  jobType: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

const RETRY_BASE_MS = 30_000; // exponential: 30s, 60s, 120s…
const STALE_LOCK_MS = 15 * 60_000; // RUNNING older than this = crashed worker

// ─── Enqueue ─────────────────────────────────────────────────────────────────

/**
 * Enqueue a job. `dedupeKey` collisions (same work already pending/running)
 * return null instead of creating a duplicate.
 */
export async function enqueueSyncJob(
  jobType: SyncJobType,
  payload: Record<string, unknown> = {},
  opts?: { dedupeKey?: string; priority?: number; runAt?: Date; maxAttempts?: number },
): Promise<{ id: string } | null> {
  // Cheap pre-check so the common "already queued" case doesn't surface as a
  // logged P2002; the catch below still guards the create against races.
  if (opts?.dedupeKey) {
    const dupe = await prisma.syncJob.findUnique({
      where: { dedupeKey: opts.dedupeKey },
      select: { id: true },
    });
    if (dupe) return null;
  }
  try {
    return await prisma.syncJob.create({
      data: {
        jobType,
        payload: payload as object,
        dedupeKey: opts?.dedupeKey ?? null,
        priority: opts?.priority ?? 0,
        runAt: opts?.runAt ?? new Date(),
        maxAttempts: opts?.maxAttempts ?? 3,
      },
      select: { id: true },
    });
  } catch (err) {
    // P2002 on dedupeKey — identical job already queued. That's a no-op.
    if ((err as { code?: string }).code === "P2002") return null;
    throw err;
  }
}

/**
 * Enqueue a full-detail sync for one anime, deduplicated. Skips entirely when
 * a non-stub row was already synced within the last 7 days (unless forced).
 */
export async function enqueueAnimeFullSync(
  malId: number,
  opts?: { priority?: number; force?: boolean },
): Promise<{ id: string } | null> {
  if (!opts?.force) {
    const row = await prisma.anime.findUnique({
      where: { malId },
      select: { isStub: true, lastSyncedAt: true },
    });
    const freshCutoff = Date.now() - 7 * 24 * 60 * 60_000;
    if (row && !row.isStub && row.lastSyncedAt && row.lastSyncedAt.getTime() > freshCutoff) {
      return null;
    }
  }
  return enqueueSyncJob(
    SYNC_JOB.ANIME_FULL,
    { malId },
    { dedupeKey: `${SYNC_JOB.ANIME_FULL}:${malId}`, priority: opts?.priority ?? 0 },
  );
}

export function enqueueEpisodeSync(malId: number): Promise<{ id: string } | null> {
  return enqueueSyncJob(
    SYNC_JOB.EPISODES,
    { malId },
    // priority -1: episode lists are ~half of all Jikan requests; running
    // them BELOW catalog sweeps/full syncs means every anime's core data
    // lands first and episodes backfill afterwards.
    { dedupeKey: `${SYNC_JOB.EPISODES}:${malId}`, priority: -1 },
  );
}

// ─── Claim / complete / fail ─────────────────────────────────────────────────

/** Atomically claim the next runnable job (highest priority, oldest first).
 *  Returns null only when no runnable job exists. Concurrent claimers race
 *  on updateMany; losing a race means another worker took that job, so we
 *  simply pick the next candidate — global progress is guaranteed. */
export async function claimNextJob(): Promise<SyncJobRow | null> {
  for (;;) {
    const candidate = await prisma.syncJob.findFirst({
      where: { status: "PENDING", runAt: { lte: new Date() } },
      orderBy: [{ priority: "desc" }, { runAt: "asc" }],
      select: { id: true, jobType: true, payload: true, attempts: true, maxAttempts: true },
    });
    if (!candidate) return null;

    const { count } = await prisma.syncJob.updateMany({
      where: { id: candidate.id, status: "PENDING" },
      data: { status: "RUNNING", lockedAt: new Date(), attempts: { increment: 1 } },
    });
    if (count === 1) return { ...candidate, attempts: candidate.attempts + 1 };
  }
}

export async function completeJob(id: string): Promise<void> {
  await prisma.syncJob.update({
    where: { id },
    // Clear dedupeKey so the same work can be enqueued again later.
    data: { status: "DONE", dedupeKey: null, lockedAt: null, lastError: null },
  });
}

/** Retry with exponential backoff until maxAttempts, then mark FAILED. */
export async function failJob(job: SyncJobRow, error: string): Promise<void> {
  const exhausted = job.attempts >= job.maxAttempts;
  await prisma.syncJob.update({
    where: { id: job.id },
    data: exhausted
      ? { status: "FAILED", dedupeKey: null, lockedAt: null, lastError: error.slice(0, 2000) }
      : {
          status: "PENDING",
          lockedAt: null,
          lastError: error.slice(0, 2000),
          runAt: new Date(Date.now() + RETRY_BASE_MS * 2 ** (job.attempts - 1)),
        },
  });
}

/**
 * Enqueue full syncs for every anime of a given priority tier whose
 * lastSyncedAt is older than the cutoff (or null). Used by the refresh-*
 * jobs; bypasses the 7-day freshness skip (staleness already proven).
 */
export async function enqueueStaleRefreshBatch(
  priority: "HOT" | "NORMAL" | "COLD",
  olderThanMs: number,
  batchMax: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await prisma.anime.findMany({
    where: {
      syncPriority: priority,
      OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: cutoff } }],
      // 5+ consecutive failures = stop auto-retrying (recordSyncFailure also
      // demotes these to COLD; the filter makes the contract explicit).
      syncFailCount: { lt: 5 },
    },
    orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } },
    take: batchMax,
    select: { malId: true },
  });

  let enqueued = 0;
  for (const r of rows) {
    const job = await enqueueSyncJob(
      SYNC_JOB.ANIME_FULL,
      { malId: r.malId },
      { dedupeKey: `${SYNC_JOB.ANIME_FULL}:${r.malId}` },
    );
    if (job) enqueued++;
  }
  return enqueued;
}

// ─── Maintenance / observability ─────────────────────────────────────────────

/** Requeue RUNNING jobs whose worker died mid-flight (crash recovery). */
export async function requeueStaleJobs(): Promise<number> {
  const { count } = await prisma.syncJob.updateMany({
    where: { status: "RUNNING", lockedAt: { lt: new Date(Date.now() - STALE_LOCK_MS) } },
    data: { status: "PENDING", lockedAt: null },
  });
  return count;
}

/**
 * Auto-requeue FAILED jobs whose error signature is a transient upstream
 * blip (MAL down/refusing, Jikan 5xx, empty envelope). Permanent failures
 * (bad payloads, unknown job types) stay FAILED for human review.
 * dedupeKey is left null — the freshness check + idempotent upserts make an
 * accidental duplicate harmless.
 */
export async function requeueTransientFailures(): Promise<number> {
  const { count } = await prisma.syncJob.updateMany({
    where: {
      status: "FAILED",
      OR: [
        { lastError: { contains: "MyAnimeList" } },
        { lastError: { contains: "Jikan returned 5" } },
        { lastError: { contains: "Jikan returned 429" } },
        { lastError: { contains: "empty data envelope" } },
        { lastError: { contains: "network-error" } },
        { lastError: { contains: "timeout" } },
      ],
    },
    data: { status: "PENDING", attempts: 0, runAt: new Date(), lastError: null },
  });
  return count;
}

/** Drop finished queue rows after 7 days so the table stays small. */
export async function purgeFinishedJobs(): Promise<number> {
  const { count } = await prisma.syncJob.deleteMany({
    where: {
      status: { in: ["DONE", "FAILED"] },
      updatedAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60_000) },
    },
  });
  return count;
}

export async function getQueueDepth(): Promise<Record<string, number>> {
  const rows = await prisma.syncJob.groupBy({ by: ["status"], _count: { _all: true } });
  const out: Record<string, number> = { PENDING: 0, RUNNING: 0, DONE: 0, FAILED: 0 };
  for (const r of rows) out[r.status] = r._count._all;
  return out;
}
