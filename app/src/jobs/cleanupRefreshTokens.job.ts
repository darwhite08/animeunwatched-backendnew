import { prisma } from "../config/prisma"

export async function cleanupRefreshTokens(): Promise<void> {
  const now = new Date()
  // Rotated tokens linger only for the grace window — purge ones rotated >10min
  // ago, plus all expired tokens.
  const { count } = await prisma.refreshToken.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: now } },
        { rotatedAt: { lt: new Date(now.getTime() - 10 * 60_000) } },
      ],
    },
  })
  if (count > 0) console.log(`[Job] Cleaned up ${count} expired/rotated refresh tokens`)
}
