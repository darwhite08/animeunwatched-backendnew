import { refreshTopAnime } from "./refreshTopAnime.job"
import { cleanupRefreshTokens } from "./cleanupRefreshTokens.job"
import { startWebhookDispatcher } from "./webhookDispatcher.job"
import { runDataRetention } from "./dataRetention.job"
import { runReportScheduler } from "./reportScheduler.job"
import { runAuditChainCheck } from "./auditChainCheck.job"
import { registerJob, instrument } from "../lib/jobRegistry"
import { flushSlaMetrics } from "../middlewares/slaMetrics.middleware"
import { runSyntheticMonitors } from "./syntheticMonitor.job"
import { flushLogs } from "../lib/logSink"
import { backupHeartbeat } from "./backupHeartbeat.job"
import { runExportJobs } from "../lib/exportRunner"
import { drainSyncQueue, startAnimeSyncSchedules, startMangaSyncSchedules, syncQueueMaintenance } from "./animeSync.worker"
import { computeTrending } from "../lib/trending/trending.service"
import { collectBuzz } from "../lib/buzz"
import { runDmNightlyCleanup, runDmUnreadReconcile, runDmExpiry } from "./dmMaintenance.job"
import { runReEngagementCampaign } from "./reEngagementCampaign.job"
import { runMessageEmailNotifications } from "./messageEmailDigest.job"

export function startJobs() {
  // Win-back inactive users — checks daily (robust to restarts), but the job's
  // own 14-day per-user cooldown means each user is re-engaged at most fortnightly.
  // Inert until SMTP is configured. NOT run on boot, so deploys never trigger sends.
  registerJob({
    name: "reEngagementCampaign",
    description: "Email inactive users (7d+) a FOMO win-back; 14d per-user cooldown, capped 100/run + throttled",
    intervalMs: 24 * 60 * 60_000,
    handler: runReEngagementCampaign,
  });
  // DM v2 maintenance (spec §8)
  registerJob({
    name: "dmNightlyCleanup",
    description: "Purge old tombstoned DMs (30d) + stale DECLINED conversations (90d)",
    intervalMs: 24 * 60 * 60_000, handler: runDmNightlyCleanup,
  });
  registerJob({
    name: "dmUnreadReconcile",
    description: "Correct drifted DM unread counters for recently-active conversations",
    intervalMs: 60 * 60_000, handler: runDmUnreadReconcile,
  });
  registerJob({
    name: "dmExpiry",
    description: "Purge disappeared (TTL-elapsed) DM messages",
    intervalMs: 10 * 60_000, handler: runDmExpiry,
  });
  // Offline "new message" email notifications — flushes every 5 min. Only emails
  // offline recipients with DMs unread >= 5 min, batched, max 1/hour/user. Inert
  // until SMTP is configured. NOT run on boot so a deploy never fires sends.
  registerJob({
    name: "messageEmailDigest",
    description: "Email offline users about unread DMs (5m debounce, batched, 1/hour/user cooldown, opt-out aware)",
    intervalMs: 5 * 60_000, handler: runMessageEmailNotifications,
  });
  // Register jobs in the in-process registry so /admin/jobs shows them.
  registerJob({
    name: "cleanupRefreshTokens", description: "Purge expired refresh tokens",
    intervalMs: 6 * 60 * 60_000, handler: cleanupRefreshTokens,
  })
  registerJob({
    name: "refreshTopAnime", description: "Refresh top anime list from Jikan",
    intervalMs: 24 * 60 * 60_000, handler: refreshTopAnime,
  })
  registerJob({
    name: "dataRetention",   description: "Purge expired sessions/security events/audit logs per security.dataRetentionDays",
    intervalMs: 24 * 60 * 60_000, handler: runDataRetention,
  })
  registerJob({
    name: "reportScheduler", description: "Run any due ReportSchedule entries (hourly check)",
    intervalMs: 60 * 60_000,  handler: runReportScheduler,
  })
  registerJob({
    name: "auditChainCheck", description: "Verify AuditLog hash chain integrity (daily, alerts on break)",
    intervalMs: 24 * 60 * 60_000, handler: runAuditChainCheck,
  })
  registerJob({
    name: "purgeExpiredIpBlocks", description: "Delete expired IpBlock rows + stale login-attempt counters (hourly)",
    intervalMs: 60 * 60_000, handler: async () => {
      const { prisma } = await import("../config/prisma")
      const { count } = await prisma.ipBlock.deleteMany({ where: { expiresAt: { lt: new Date() } } })
      // Drop login-attempt counters with no active lock that haven't been
      // touched in a day (auto-reset; keeps the table tiny).
      const dayAgo = new Date(Date.now() - 24 * 60 * 60_000)
      const { count: la } = await prisma.loginAttempt.deleteMany({
        where: { updatedAt: { lt: dayAgo }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
      })
      // Expired rate-limit windows.
      const { count: rl } = await prisma.rateLimitBucket.deleteMany({ where: { resetAt: { lt: new Date() } } })
      return { purged: count, loginAttempts: la, rateLimitBuckets: rl }
    },
  })
  registerJob({
    name: "flushSlaMetrics", description: "Persist in-process RED metrics into EndpointStat (every 60s)",
    intervalMs: 60_000, handler: async () => flushSlaMetrics(),
  })
  registerJob({
    name: "syntheticMonitors", description: "Probe enabled SyntheticMonitor rows on their interval",
    intervalMs: 30_000, handler: runSyntheticMonitors,
  })
  registerJob({
    name: "flushLogs", description: "Flush in-process WARN+ log buffer to Postgres (every 5s)",
    intervalMs: 5_000, handler: async () => flushLogs(),
  })
  registerJob({
    name: "backupHeartbeat", description: "Alert if no critical-kind backup in the last RPO window (hourly)",
    intervalMs: 60 * 60_000, handler: backupHeartbeat,
  })
  registerJob({
    name: "exportRunner", description: "Process pending ExportJob rows; lands files in S3 (every 30s)",
    intervalMs: 30_000, handler: async () => runExportJobs(3),
  })
  registerJob({
    name: "animeSyncWorker", description: "Drain the SyncJob queue (Jikan full syncs, episodes, seeds) at the global rate limit",
    intervalMs: 15_000, handler: drainSyncQueue,
  })
  registerJob({
    name: "animeSyncMaintenance", description: "Requeue stale RUNNING sync jobs + purge finished rows (hourly)",
    intervalMs: 60 * 60_000, handler: syncQueueMaintenance,
  })
  registerJob({
    name: "computeTrending", description: "Recompute 'Trending Now' (deseasonalized robust-z + NEWMA) from first-party activity (every 20 min)",
    intervalMs: 20 * 60_000, handler: () => computeTrending(),
  })
  registerJob({
    name: "collectBuzz", description: "Gather off-platform web buzz (AniList trending + Wikimedia pageviews) into trending (hourly)",
    intervalMs: 60 * 60_000, handler: () => collectBuzz(),
  })
  registerJob({
    name: "releaseHeldEarnings", description: "Move creator earnings past their 7-day hold to 'available' (hourly)",
    intervalMs: 60 * 60_000, handler: async () => {
      const { releaseHeldEarnings } = await import("../modules/monetization/monetization.service")
      return { released: await releaseHeldEarnings() }
    },
  })
  registerJob({
    name: "publishScheduledBlogs", description: "Auto-publish SCHEDULED blogs whose scheduledAt has passed (every minute)",
    intervalMs: 60_000, handler: async () => {
      const { publishDueScheduled } = await import("../modules/blogs/blogs.service")
      return { published: await publishDueScheduled() }
    },
  })
  registerJob({
    name: "backfillYoutubeTrailers", description: "Resolve official YouTube trailers (search + AI pick) for popular anime missing one — inert unless YOUTUBE_API_KEY is set",
    intervalMs: 6 * 60 * 60_000, handler: async () => {
      const { backfillTrailers } = await import("../modules/anime/youtubeTrailer.service")
      return backfillTrailers(80)
    },
  })
  registerJob({
    name: "refreshInstagramTokens", description: "Renew Instagram long-lived tokens nearing expiry so Shots connections never lapse (every 12h)",
    intervalMs: 12 * 60 * 60_000, handler: async () => {
      const { refreshExpiringInstagramTokens } = await import("../modules/social/social.service")
      return refreshExpiringInstagramTokens()
    },
  })
  registerJob({
    name: "leaderboardSnapshot", description: "Daily all-time global standings snapshot per board — powers leaderboard rank-movement deltas (14-day retention)",
    intervalMs: 6 * 60 * 60_000, handler: async () => {
      const { snapshotLeaderboards } = await import("./leaderboardSnapshot.job")
      return snapshotLeaderboards()
    },
  })

  const cleanup    = instrument("cleanupRefreshTokens", cleanupRefreshTokens)
  const refresh    = instrument("refreshTopAnime",      refreshTopAnime)
  const retention  = instrument("dataRetention",        runDataRetention)
  const reports    = instrument("reportScheduler",      runReportScheduler)
  const chainCheck = instrument("auditChainCheck",      runAuditChainCheck)

  // Cleanup every 6 hours
  setInterval(cleanup, 6 * 60 * 60_000)
  cleanup().catch(console.error)

  // Refresh top anime from Jikan on startup + every 24 hours
  refresh().catch(console.error)
  setInterval(refresh, 24 * 60 * 60_000)

  // Data retention purger — daily
  setInterval(retention, 24 * 60 * 60_000)

  // Report scheduler — hourly check
  setInterval(reports, 60 * 60_000)

  // Audit chain integrity — once on startup, then every 24h
  chainCheck().catch(console.error)
  setInterval(chainCheck, 24 * 60 * 60_000)

  // Re-engagement win-back — daily check, deliberately NOT run on boot so a
  // deploy can never fire a campaign. Per-user 14-day cooldown does the rest.
  const reEngage = instrument("reEngagementCampaign", runReEngagementCampaign)
  setInterval(reEngage, 24 * 60 * 60_000)

  // Offline new-message email flush — every 5 min. NOT run on boot (sends mail);
  // the 5-min debounce means freshly-arrived messages wait for the next tick.
  const msgEmail = instrument("messageEmailDigest", runMessageEmailNotifications)
  setInterval(msgEmail, 5 * 60_000)

  // Webhook dispatcher — polls WebhookDelivery rows every 30s
  startWebhookDispatcher()

  // SLA metric flush — every 60s the in-process buckets are persisted into EndpointStat
  const slaFlush = instrument("flushSlaMetrics", flushSlaMetrics)
  setInterval(slaFlush, 60_000)

  // Synthetic monitor probes — every 30s pick up any monitors that are due
  const synth = instrument("syntheticMonitors", runSyntheticMonitors)
  setInterval(synth, 30_000)

  // Log buffer flush — every 5s the in-process WARN+ buffer goes to Postgres
  const logFlush = instrument("flushLogs", flushLogs)
  setInterval(logFlush, 5_000)

  // Backup heartbeat — hourly check that critical backups landed within RPO
  const bh = instrument("backupHeartbeat", backupHeartbeat)
  setInterval(bh, 60 * 60_000)

  // Async export runner — every 30s pick up to 3 pending ExportJobs
  const exp = instrument("exportRunner", () => runExportJobs(3))
  setInterval(exp, 30_000)

  // Anime sync worker — drain tick every 15s (the loop runs until the queue
  // is empty, so the tick only matters when the queue was idle) + hourly
  // crash-recovery/purge + repeatable refresh/seed schedules.
  const animeDrain = instrument("animeSyncWorker", drainSyncQueue)
  setInterval(animeDrain, 15_000)
  animeDrain().catch(console.error)
  const animeMaint = instrument("animeSyncMaintenance", syncQueueMaintenance)
  setInterval(animeMaint, 60 * 60_000)
  animeMaint().catch(console.error)
  startAnimeSyncSchedules()
  // Manga catalog sync — same SyncJob queue/drain loop, lower priorities, plus
  // a one-time cold-catalog bootstrap sweep (guarded, restart-safe).
  startMangaSyncSchedules()

  // One-off on boot: link legacy AniList-keyed readlist entries to the local
  // Manga catalog (idempotent — only rows where mangaId IS NULL).
  setTimeout(() => {
    import("../modules/readlist/readlist.service")
      .then((m) => m.backfillCatalogLinks())
      .then((r) => { if (r.linked) console.log(`[readlist] linked ${r.linked}/${r.scanned} legacy entries to the manga catalog`) })
      .catch(console.error)
  }, 150_000)

  // Trending Now — recompute every 20 min from first-party activity (O(1) per
  // active title, no history rescan). One run on boot to warm trendingScore.
  const trending = instrument("computeTrending", () => computeTrending())
  setInterval(trending, 20 * 60_000)
  trending().catch(console.error)

  // Off-platform web buzz (AniList trending + Wikimedia pageviews) — hourly,
  // candidate-gated. Runs ~30s after boot so the catalog/states exist first.
  const buzz = instrument("collectBuzz", () => collectBuzz())
  setInterval(buzz, 60 * 60_000)
  setTimeout(() => { buzz().catch(console.error) }, 30_000)

  // Release creator earnings past their 7-day hold (hourly).
  const releaseEarnings = instrument("releaseHeldEarnings", async () => {
    const { releaseHeldEarnings } = await import("../modules/monetization/monetization.service")
    return { released: await releaseHeldEarnings() }
  })
  setInterval(releaseEarnings, 60 * 60_000)

  // Auto-publish scheduled blogs — check every minute.
  const publishScheduled = instrument("publishScheduledBlogs", async () => {
    const { publishDueScheduled } = await import("../modules/blogs/blogs.service")
    return { published: await publishDueScheduled() }
  })
  setInterval(publishScheduled, 60_000)

  // Continuous YouTube trailer worker — keeps resolving an official trailer for
  // EVERY anime missing one, forever, with zero manual intervention. It bursts
  // through small batches (popularity-first) and self-throttles around the
  // YouTube daily quota: on quota-exhaustion it backs off ~1h (quota resets
  // daily) WITHOUT marking anything checked, then resumes automatically; when the
  // catalog is fully covered it idles and rechecks periodically. Inert unless
  // YOUTUBE_API_KEY is set. First tick ~2min after boot.
  const TRAILER_BATCH = 3
  const ACTIVE_DELAY  = 20_000        // work remains → keep going
  const IDLE_DELAY    = 30 * 60_000   // caught up (or no API key) → recheck later
  const QUOTA_DELAY   = 60 * 60_000   // out of quota → retry in ~1h
  const ERROR_DELAY   = 5 * 60_000
  // Daily self-cap so the background worker can't consume the ENTIRE shared
  // YouTube quota — it leaves headroom for user-facing lookups (the /watch
  // resolver + lazy trailer-on-view). ~70 trailers/day backfilled; the rest of
  // the ~100/day quota stays free for what users actually request right now.
  const TRAILER_DAILY_CAP = 70
  let trailerDay = ""          // UTC date string of the current budget window
  let trailerToday = 0
  const tickTrailerWorker = async (): Promise<void> => {
    let delay = ERROR_DELAY
    try {
      const today = new Date().toISOString().slice(0, 10)
      if (today !== trailerDay) { trailerDay = today; trailerToday = 0 } // new day → reset budget
      if (trailerToday >= TRAILER_DAILY_CAP) {
        delay = IDLE_DELAY // budget spent for today; recheck after the daily reset
      } else {
        const { backfillTrailers } = await import("../modules/anime/youtubeTrailer.service")
        const r = await backfillTrailers(TRAILER_BATCH)
        trailerToday += r.resolved + (r.scanned - r.resolved) // count attempts toward the cap
        if (r.skipped || r.scanned === 0) delay = IDLE_DELAY
        else if (r.quotaExceeded) delay = QUOTA_DELAY
        else delay = ACTIVE_DELAY
        if (r.resolved) console.log(`[trailerWorker] resolved ${r.resolved}/${r.scanned} (today ${trailerToday}/${TRAILER_DAILY_CAP})`)
      }
    } catch (e) {
      console.error("[trailerWorker]", (e as Error)?.message ?? e)
    } finally {
      setTimeout(tickTrailerWorker, delay)
    }
  }
  setTimeout(tickTrailerWorker, 120_000)

  // Instagram token refresh — renew long-lived tokens nearing expiry so Shots
  // connections never lapse (each refresh extends +60 days). Every 12h, plus a
  // run ~60s after boot. Inert unless Instagram is configured.
  const refreshIgTokens = instrument("refreshInstagramTokens", async () => {
    const { refreshExpiringInstagramTokens } = await import("../modules/social/social.service")
    return refreshExpiringInstagramTokens()
  })
  setInterval(refreshIgTokens, 12 * 60 * 60_000)
  setTimeout(() => { refreshIgTokens().catch(console.error) }, 60_000)

  // Leaderboard rank snapshots — idempotent per UTC day, so a 6h check interval
  // just guarantees the daily row lands even across restarts/timezone edges.
  // First run ~45s after boot.
  const lbSnap = instrument("leaderboardSnapshot", async () => {
    const { snapshotLeaderboards } = await import("./leaderboardSnapshot.job")
    return snapshotLeaderboards()
  })
  setInterval(lbSnap, 6 * 60 * 60_000)
  setTimeout(() => { lbSnap().catch(console.error) }, 45_000)

  // One-off on boot: ensure the Founding Creator counter row exists (idempotent).
  setTimeout(() => {
    import("../lib/founding")
      .then((m) => m.ensureFoundingCounter())
      .catch((e) => console.error("[Boot] ensureFoundingCounter failed:", e))
  }, 6_000)

  // One-off on boot: give slug-less (older) accounts a slug so /user/[slug]/*
  // routing works for them. Idempotent — only updates rows where slug IS NULL.
  setTimeout(() => {
    import("../modules/users/users.service")
      .then((m) => m.backfillMissingSlugs())
      .then((n) => { if (n) console.log(`[Boot] Backfilled ${n} missing user slug(s)`) })
      .catch(console.error)
  }, 8_000)

  console.log("[Jobs] Background jobs started")
}
