import { prisma } from "../config/prisma"

export async function cleanupRefreshTokens(): Promise<void> {
  const { count } = await prisma.refreshToken.deleteMany({
    where: { expiresAt: { lt: new Date() } }
  })
  if (count > 0) console.log(`[Job] Cleaned up ${count} expired refresh tokens`)
}
