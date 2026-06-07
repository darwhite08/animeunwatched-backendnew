/**
 * Anime sync worker — drains the Postgres-backed SyncJob queue.
 *
 * Concurrency is 1 by design: the shared Jikan token bucket
 * (lib/catalog/jikanClient.ts) does the pacing, and sequential processing
 * avoids hammering the upstream. The drain loop runs until the queue is
 * empty; the 15s tick in jobs/index.ts simply re-enters it when new work
 * arrives. A multi-hour seed survives restarts because queue state is rows,
 * not memory.
 */
import { env } from "../config/env";
import { JikanError, browseAnime, getAnimeFull, getSeasonPage, getTopAnimePage } from "../lib/catalog/jikanClient";
import {
  getAnimeIdByMalId,
  logSyncJob,
  recordSyncFailure,
  syncEpisodes,
  upsertAnimeFromJikan,
  upsertStubFromSearchResult,
} from "../modules/anime/animeSync.service";
import {
  SYNC_JOB,
  claimNextJob,
  completeJob,
  enqueueAnimeFullSync,
  enqueueEpisodeSync,
  enqueueSyncJob,
  failJob,
  purgeFinishedJobs,
  requeueStaleJobs,
  type SyncJobRow,
} from "../modules/anime/syncQueue.service";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Pages a single seed-top job processes before chaining a continuation job.
 *  Small chunks = restart-safe progress through a 400-page seed. */
const SEED_CHUNK_PAGES = 3;

// ─── Job handlers ────────────────────────────────────────────────────────────

async function handleAnimeFull(payload: { malId: number }): Promise<void> {
  const full = await getAnimeFull(payload.malId);
  const anime = await upsertAnimeFromJikan(full);
  // Episode lists only exist for shows that actually have episodes.
  if ((anime.episodes ?? 0) > 0) {
    await enqueueEpisodeSync(payload.malId);
  }
}

async function handleEpisodes(payload: { malId: number }): Promise<void> {
  const animeId = await getAnimeIdByMalId(payload.malId);
  if (!animeId) throw new Error(`sync-episodes: no local row for malId ${payload.malId}`);
  await syncEpisodes(animeId, payload.malId);
}

/**
 * Shared page-walker for list seeds: stub-upsert every item on each page,
 * enqueue its full-detail sync (deduped + freshness-skipped), then chain a
 * continuation job for the next chunk so progress is durable across restarts.
 */
async function seedListPages(
  jobType: typeof SYNC_JOB.SEED_TOP | typeof SYNC_JOB.SEED_ALL,
  fetchPage: (page: number) => ReturnType<typeof getTopAnimePage>,
  payload: { fromPage: number; toPage: number },
): Promise<void> {
  const { fromPage, toPage } = payload;
  const lastChunkPage = Math.min(fromPage + SEED_CHUNK_PAGES - 1, toPage);
  let hasNext = true;

  for (let page = fromPage; page <= lastChunkPage && hasNext; page++) {
    const res = await fetchPage(page);
    for (const item of res.data ?? []) {
      await upsertStubFromSearchResult(item);
      await enqueueAnimeFullSync(item.mal_id); // dedupe + 7-day freshness skip inside
    }
    hasNext = res.pagination?.has_next_page ?? (res.data ?? []).length > 0;
  }

  if (hasNext && lastChunkPage < toPage) {
    await enqueueSyncJob(
      jobType,
      { fromPage: lastChunkPage + 1, toPage },
      { dedupeKey: `${jobType}:${lastChunkPage + 1}-${toPage}` },
    );
  }
}

function handleSeedTop(payload: { fromPage: number; toPage: number }): Promise<void> {
  return seedListPages(SYNC_JOB.SEED_TOP, getTopAnimePage, payload);
}

/** Complete catalog sweep: /anime ordered by mal_id covers every entry on
 *  MAL (~30.2k as of June 2026), including unranked/unscored ones that
 *  /top/anime misses. */
function handleSeedAll(payload: { fromPage: number; toPage: number }): Promise<void> {
  return seedListPages(
    SYNC_JOB.SEED_ALL,
    (page) => browseAnime(`page=${page}&order_by=mal_id&sort=asc`),
    payload,
  );
}

async function handleSeedSeason(payload: {
  year: number;
  season: "winter" | "spring" | "summer" | "fall";
}): Promise<void> {
  let page = 1;
  for (;;) {
    const res = await getSeasonPage(payload.year, payload.season, page);
    for (const item of res.data ?? []) {
      await upsertStubFromSearchResult(item);
      await enqueueAnimeFullSync(item.mal_id);
    }
    if (!res.pagination?.has_next_page || (res.data ?? []).length === 0) break;
    page++;
  }
}

async function handleRefresh(priority: "HOT" | "NORMAL" | "COLD"): Promise<void> {
  const { enqueueStaleRefreshBatch } = await import("../modules/anime/syncQueue.service");
  const config = {
    HOT: { olderThanMs: env.ANIME_SYNC_HOT_INTERVAL_HOURS * HOUR_MS, batchMax: 1_000 },
    NORMAL: { olderThanMs: env.ANIME_SYNC_NORMAL_DAYS * DAY_MS, batchMax: 500 },
    COLD: { olderThanMs: env.ANIME_SYNC_COLD_DAYS * DAY_MS, batchMax: 300 },
  }[priority];
  const enqueued = await enqueueStaleRefreshBatch(priority, config.olderThanMs, config.batchMax);
  console.log(`[animeSync] refresh-${priority.toLowerCase()}: enqueued ${enqueued} full syncs`);
}

async function handleJob(job: SyncJobRow): Promise<void> {
  const payload = job.payload as Record<string, unknown>;
  switch (job.jobType) {
    case SYNC_JOB.ANIME_FULL:
      return handleAnimeFull(payload as { malId: number });
    case SYNC_JOB.EPISODES:
      return handleEpisodes(payload as { malId: number });
    case SYNC_JOB.SEED_TOP:
      return handleSeedTop(payload as { fromPage: number; toPage: number });
    case SYNC_JOB.SEED_ALL:
      return handleSeedAll(payload as { fromPage: number; toPage: number });
    case SYNC_JOB.SEED_SEASON:
      return handleSeedSeason(payload as { year: number; season: "winter" | "spring" | "summer" | "fall" });
    case SYNC_JOB.REFRESH_HOT:
      return handleRefresh("HOT");
    case SYNC_JOB.REFRESH_NORMAL:
      return handleRefresh("NORMAL");
    case SYNC_JOB.REFRESH_COLD:
      return handleRefresh("COLD");
    default:
      throw new Error(`Unknown sync job type: ${job.jobType}`);
  }
}

// ─── Drain loop ──────────────────────────────────────────────────────────────

let draining = false;

export async function drainSyncQueue(): Promise<{ processed: number }> {
  if (draining) return { processed: 0 };
  draining = true;
  let processed = 0;

  try {
    for (;;) {
      const job = await claimNextJob();
      if (!job) break;

      const started = Date.now();
      const malId = (job.payload as { malId?: number }).malId ?? null;

      try {
        await handleJob(job);
        await completeJob(job.id);
        await logSyncJob({
          jobType: job.jobType,
          malId,
          status: "success",
          durationMs: Date.now() - started,
        });
      } catch (err) {
        const message = (err as Error).message ?? "unknown error";

        if (err instanceof JikanError && err.isNotFound) {
          // malId doesn't exist upstream — retrying will never help.
          await completeJob(job.id);
          await logSyncJob({
            jobType: job.jobType,
            malId,
            status: "skipped",
            error: "404 from Jikan",
            durationMs: Date.now() - started,
          });
        } else {
          await failJob(job, message);
          if (job.jobType === SYNC_JOB.ANIME_FULL && malId) {
            await recordSyncFailure(malId);
          }
          await logSyncJob({
            jobType: job.jobType,
            malId,
            status: "failed",
            error: message,
            durationMs: Date.now() - started,
          });
          console.warn(`[animeSync] ${job.jobType} failed (attempt ${job.attempts}/${job.maxAttempts}): ${message}`);
        }
      }
      processed++;
    }
  } finally {
    draining = false;
  }

  return { processed };
}

// ─── Schedules ───────────────────────────────────────────────────────────────

function currentSeason(): { year: number; season: "winter" | "spring" | "summer" | "fall" } {
  const now = new Date();
  const month = now.getUTCMonth(); // 0-11
  const season = month <= 2 ? "winter" : month <= 5 ? "spring" : month <= 8 ? "summer" : "fall";
  return { year: now.getUTCFullYear(), season };
}

/** ms until the next occurrence of hh:mm IST (UTC+5:30), optionally on a
 *  specific weekday (0=Sunday, in IST). */
function msUntilIST(hour: number, minute: number, weekday?: number): number {
  const IST_OFFSET_MS = 5.5 * HOUR_MS;
  const nowIST = Date.now() + IST_OFFSET_MS;
  const d = new Date(nowIST);
  d.setUTCHours(hour, minute, 0, 0);
  let target = d.getTime();
  if (weekday !== undefined) {
    const delta = (weekday - d.getUTCDay() + 7) % 7;
    target += delta * DAY_MS;
  }
  while (target <= nowIST) target += weekday !== undefined ? 7 * DAY_MS : DAY_MS;
  return target - nowIST;
}

export function enqueueRefreshHot(): Promise<{ id: string } | null> {
  return enqueueSyncJob(SYNC_JOB.REFRESH_HOT, {}, { dedupeKey: SYNC_JOB.REFRESH_HOT, priority: 10 });
}

export function enqueueRefreshNormal(): Promise<{ id: string } | null> {
  return enqueueSyncJob(SYNC_JOB.REFRESH_NORMAL, {}, { dedupeKey: SYNC_JOB.REFRESH_NORMAL, priority: 5 });
}

export function enqueueRefreshCold(): Promise<{ id: string } | null> {
  return enqueueSyncJob(SYNC_JOB.REFRESH_COLD, {}, { dedupeKey: SYNC_JOB.REFRESH_COLD, priority: 1 });
}

export function enqueueCurrentSeasonSeed(): Promise<{ id: string } | null> {
  const { year, season } = currentSeason();
  return enqueueSyncJob(
    SYNC_JOB.SEED_SEASON,
    { year, season },
    { dedupeKey: `${SYNC_JOB.SEED_SEASON}:${year}:${season}`, priority: 5 },
  );
}

export async function syncQueueMaintenance(): Promise<{ requeued: number; purged: number }> {
  const requeued = await requeueStaleJobs();
  const purged = await purgeFinishedJobs();
  return { requeued, purged };
}

/**
 * Repeatable schedules (spec §4):
 *   refresh-hot    — every ANIME_SYNC_HOT_INTERVAL_HOURS (default 6h)
 *   refresh-normal — daily 02:00 IST
 *   refresh-cold   — weekly Sunday 03:00 IST
 *   seed-season    — weekly (picks up newly announced shows)
 * Each schedule just ENQUEUES a queue row; the drain loop does the work, so
 * scheduled and admin-triggered runs share one code path.
 */
export function startAnimeSyncSchedules(): void {
  const hotMs = env.ANIME_SYNC_HOT_INTERVAL_HOURS * HOUR_MS;
  setInterval(() => void enqueueRefreshHot().catch(console.error), hotMs);

  setTimeout(() => {
    void enqueueRefreshNormal().catch(console.error);
    setInterval(() => void enqueueRefreshNormal().catch(console.error), DAY_MS);
  }, msUntilIST(2, 0));

  setTimeout(() => {
    void enqueueRefreshCold().catch(console.error);
    setInterval(() => void enqueueRefreshCold().catch(console.error), 7 * DAY_MS);
  }, msUntilIST(3, 0, 0));

  setTimeout(() => {
    void enqueueCurrentSeasonSeed().catch(console.error);
    setInterval(() => void enqueueCurrentSeasonSeed().catch(console.error), 7 * DAY_MS);
  }, 60_000); // first season sweep a minute after boot, then weekly
}
