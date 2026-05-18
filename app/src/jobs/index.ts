import { refreshTopAnime } from "./refreshTopAnime.job"
import { cleanupRefreshTokens } from "./cleanupRefreshTokens.job"

export function startJobs() {
  // Cleanup every 6 hours
  setInterval(cleanupRefreshTokens, 6 * 60 * 60_000)
  cleanupRefreshTokens().catch(console.error)

  // Refresh top anime from Jikan on startup + every 24 hours
  refreshTopAnime().catch(console.error)
  setInterval(refreshTopAnime, 24 * 60 * 60_000)

  console.log("[Jobs] Background jobs started")
}
