/**
 * Seed the local anime catalog from Jikan.
 *
 *   npm run seed:anime                  # top pages 1–400 (~10,000 titles) + last 8 seasons
 *   npm run seed:anime -- --all         # COMPLETE catalog (~30,200 entries, every mal_id)
 *   npm run seed:anime -- --from 1 --to 50
 *   npm run seed:anime -- --skip-seasons
 *
 * This script only ENQUEUES durable SyncJob rows — the actual fetching is
 * done by the in-process anime sync worker (jobs/animeSync.worker.ts) inside
 * the running API server, paced by the global Jikan limiter.
 *
 * Jikan's documented limits (docs.api.jikan.moe): 3 req/sec burst, 60 req/min,
 * unlimited daily — so the maximum sustainable rate is exactly 1 req/sec,
 * which is what JIKAN_RATE_PER_SEC defaults to.
 *
 * Expected duration at 1 req/sec:
 *   default: ~400 list pages + ~10k full fetches ≈ 3+ hours
 *   --all:   ~1.2k list pages + ~30k full fetches + episode lists ≈ 17–19 hours
 * Run the server (`npm run dev` or production) and the queue drains in the
 * background; progress survives restarts.
 * Monitor with GET /api/v1/admin/sync/status.
 */
import "dotenv/config";
import { prisma } from "../app/src/config/prisma";
import {
  SYNC_JOB,
  enqueueAnimeFullSync,
  enqueueSyncJob,
} from "../app/src/modules/anime/syncQueue.service";

type Season = "winter" | "spring" | "summer" | "fall";
const SEASONS: Season[] = ["winter", "spring", "summer", "fall"];

function parseArgs(): { fromPage: number; toPage: number; skipSeasons: boolean; all: boolean } {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const all = argv.includes("--all");
  return {
    fromPage: Number(get("--from")) || 1,
    // The page-walker stops on has_next_page=false, so the --all default can
    // safely overshoot the current ~1209 last page.
    toPage: Number(get("--to")) || (all ? 1300 : 400),
    skipSeasons: argv.includes("--skip-seasons"),
    all,
  };
}

/** The last `count` seasons, newest first, starting from the current one. */
function recentSeasons(count: number): Array<{ year: number; season: Season }> {
  const now = new Date();
  let year = now.getUTCFullYear();
  let idx = Math.floor(now.getUTCMonth() / 3); // 0 winter … 3 fall
  const out: Array<{ year: number; season: Season }> = [];
  for (let i = 0; i < count; i++) {
    out.push({ year, season: SEASONS[idx] });
    idx--;
    if (idx < 0) {
      idx = 3;
      year--;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { fromPage, toPage, skipSeasons, all } = parseArgs();
  console.log(
    `[seed-anime] enqueueing seed jobs (${all ? "FULL catalog" : "top"} pages ${fromPage}–${toPage}${skipSeasons ? "" : ", last 8 seasons"})`,
  );

  // 1. Backfill: every anime row already referenced by user data that has
  //    never been fully synced gets a full-detail job first (priority 5 so
  //    user-visible titles are refreshed before the bulk seed).
  const unsynced = await prisma.anime.findMany({
    where: { OR: [{ lastSyncedAt: null }, { isStub: true }] },
    select: { malId: true },
  });
  let backfilled = 0;
  for (const row of unsynced) {
    const job = await enqueueAnimeFullSync(row.malId, { priority: 5 });
    if (job) backfilled++;
  }
  console.log(`[seed-anime] backfill: ${backfilled}/${unsynced.length} existing rows enqueued for full sync`);

  // 2. Catalog sweep. One job per chunk is chained by the worker itself —
  //    we enqueue only the head job. --all walks /anime by mal_id (every
  //    entry, ~30.2k); default walks /top/anime (ranked titles only).
  const sweepType = all ? SYNC_JOB.SEED_ALL : SYNC_JOB.SEED_TOP;
  const seedJob = await enqueueSyncJob(
    sweepType,
    { fromPage, toPage },
    { dedupeKey: `${sweepType}:${fromPage}-${toPage}` },
  );
  console.log(
    seedJob
      ? `[seed-anime] ${sweepType} pages ${fromPage}–${toPage} enqueued (~${(toPage - fromPage + 1) * 25} titles)`
      : `[seed-anime] ${sweepType} pages ${fromPage}–${toPage} already queued — skipped`,
  );

  // 3. Last 8 seasons (catches seasonal shows the top list misses).
  if (!skipSeasons) {
    for (const { year, season } of recentSeasons(8)) {
      const job = await enqueueSyncJob(
        SYNC_JOB.SEED_SEASON,
        { year, season },
        { dedupeKey: `${SYNC_JOB.SEED_SEASON}:${year}:${season}` },
      );
      console.log(`[seed-anime] seed-season ${year}/${season}: ${job ? "enqueued" : "already queued"}`);
    }
  }

  const pending = await prisma.syncJob.count({ where: { status: "PENDING" } });
  console.log(`
[seed-anime] done. ${pending} jobs pending in the queue.
The sync worker inside the API server drains them at ~1 Jikan request/sec:
  ~${toPage - fromPage + 1} top pages + ~${(toPage - fromPage + 1) * 25} full-detail fetches ≈ ${Math.ceil(((toPage - fromPage + 1) * 26) / 3600)}+ hours, plus episode syncs.
Keep the server running; progress is durable across restarts.
Monitor: GET /api/v1/admin/sync/status (admin auth required).`);
}

main()
  .catch((err) => {
    console.error("[seed-anime] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
