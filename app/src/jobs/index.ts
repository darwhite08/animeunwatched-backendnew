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
import { drainSyncQueue, startAnimeSyncSchedules, syncQueueMaintenance } from "./animeSync.worker"
import { computeTrending } from "../lib/trending/trending.service"
import { collectBuzz } from "../lib/buzz"
import { runDmNightlyCleanup, runDmUnreadReconcile, runDmExpiry } from "./dmMaintenance.job"

export function startJobs() {
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
    name: "purgeExpiredIpBlocks", description: "Delete expired IpBlock rows (hourly)",
    intervalMs: 60 * 60_000, handler: async () => {
      const { prisma } = await import("../config/prisma")
      const { count } = await prisma.ipBlock.deleteMany({ where: { expiresAt: { lt: new Date() } } })
      return { purged: count }
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

  // YouTube trailer backfill — every 6h, ~80 popular anime per run (quota-bounded).
  // Inert unless YOUTUBE_API_KEY is set. First run ~2min after boot.
  const backfillTrailersJob = instrument("backfillYoutubeTrailers", async () => {
    const { backfillTrailers } = await import("../modules/anime/youtubeTrailer.service")
    return backfillTrailers(80)
  })
  setInterval(backfillTrailersJob, 6 * 60 * 60_000)
  setTimeout(() => { backfillTrailersJob().catch(console.error) }, 120_000)

  // Instagram token refresh — renew long-lived tokens nearing expiry so Shots
  // connections never lapse (each refresh extends +60 days). Every 12h, plus a
  // run ~60s after boot. Inert unless Instagram is configured.
  const refreshIgTokens = instrument("refreshInstagramTokens", async () => {
    const { refreshExpiringInstagramTokens } = await import("../modules/social/social.service")
    return refreshExpiringInstagramTokens()
  })
  setInterval(refreshIgTokens, 12 * 60 * 60_000)
  setTimeout(() => { refreshIgTokens().catch(console.error) }, 60_000)

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
