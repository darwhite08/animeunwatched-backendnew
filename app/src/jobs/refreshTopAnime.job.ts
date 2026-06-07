import { SYNC_JOB, enqueueSyncJob } from "../modules/anime/syncQueue.service"

/**
 * Daily top-anime refresh. Previously this fetched 20 Jikan pages inline with
 * its own throttle; it now just enqueues a durable `seed-top` job so the
 * anime sync worker (jobs/animeSync.worker.ts) does the fetching through the
 * shared rate limiter. Stub rows are upserted per page and full-detail syncs
 * are chained automatically (skipping anything synced within 7 days).
 */
export async function refreshTopAnime(): Promise<void> {
  const job = await enqueueSyncJob(
    SYNC_JOB.SEED_TOP,
    { fromPage: 1, toPage: 20 },
    { dedupeKey: `${SYNC_JOB.SEED_TOP}:1-20` },
  )
  console.log(
    job
      ? "[Job] refreshTopAnime: enqueued seed-top pages 1-20"
      : "[Job] refreshTopAnime: seed-top already queued — skipped",
  )
}
