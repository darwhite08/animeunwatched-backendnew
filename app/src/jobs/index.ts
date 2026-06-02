import { refreshTopAnime } from "./refreshTopAnime.job"
import { cleanupRefreshTokens } from "./cleanupRefreshTokens.job"
import { startWebhookDispatcher } from "./webhookDispatcher.job"
import { runDataRetention } from "./dataRetention.job"
import { registerJob, instrument } from "../lib/jobRegistry"

export function startJobs() {
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

  const cleanup   = instrument("cleanupRefreshTokens", cleanupRefreshTokens)
  const refresh   = instrument("refreshTopAnime",      refreshTopAnime)
  const retention = instrument("dataRetention",        runDataRetention)

  // Cleanup every 6 hours
  setInterval(cleanup, 6 * 60 * 60_000)
  cleanup().catch(console.error)

  // Refresh top anime from Jikan on startup + every 24 hours
  refresh().catch(console.error)
  setInterval(refresh, 24 * 60 * 60_000)

  // Data retention purger — daily
  setInterval(retention, 24 * 60 * 60_000)

  // Webhook dispatcher — polls WebhookDelivery rows every 30s
  startWebhookDispatcher()

  console.log("[Jobs] Background jobs started")
}
