import { refreshTopAnime } from "./refreshTopAnime.job"
import { cleanupRefreshTokens } from "./cleanupRefreshTokens.job"

export function startJobs() {
  // Run cleanup every 6 hours
  setInterval(cleanupRefreshTokens, 6 * 60 * 60_000)
  // Immediately run once on startup
  cleanupRefreshTokens().catch(console.error)
  console.log("[Jobs] Background jobs started")
}
