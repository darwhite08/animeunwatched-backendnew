/**
 * Backfill User.country/region for existing users from their most-recent
 * session IP (RefreshToken / SecurityEvent). Geo via the cached geoip lib.
 *
 *   set -a; source ~/kaiveron-secrets/backend-apprunner.env; set +a
 *   npx tsx scripts/backfill-user-geo.ts          # dry run
 *   npx tsx scripts/backfill-user-geo.ts --write   # apply
 */
import { prisma } from "../app/src/config/prisma"
import { getIpProfile, refreshIpProfile } from "../app/src/lib/geoip"

async function latestIp(userId: string): Promise<string | null> {
  const rt = await prisma.refreshToken.findFirst({
    where: { userId, ipAddress: { not: null } },
    orderBy: { lastUsedAt: "desc" },
    select: { ipAddress: true },
  })
  if (rt?.ipAddress) return rt.ipAddress
  const ev = await prisma.securityEvent.findFirst({
    where: { userId, ipAddress: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { ipAddress: true },
  }).catch(() => null)
  return ev?.ipAddress ?? null
}

async function main() {
  const write = process.argv.includes("--write")
  const users = await prisma.user.findMany({ where: { country: null }, select: { id: true, username: true } })
  console.log(`${users.length} users missing country${write ? "" : "  (DRY RUN — pass --write)"}`)
  let set = 0, noIp = 0, noGeo = 0
  for (const u of users) {
    const ip = await latestIp(u.id)
    if (!ip) { noIp++; continue }
    // Synchronous fetch (cached-or-fetch) so cold IPs resolve in one pass.
    const geo = (await getIpProfile(ip))?.country ? await getIpProfile(ip) : await refreshIpProfile(ip)
    if (!geo?.country) { noGeo++; continue }
    console.log(`  @${u.username} → ${geo.country}${geo.region ? " / " + geo.region : ""}  (${ip})`)
    if (write) {
      await prisma.user.update({ where: { id: u.id }, data: { country: geo.country, region: geo.region ?? null } })
    }
    set++
    await new Promise((r) => setTimeout(r, 1500)) // ip-api free tier: 45 req/min
  }
  console.log(`\n${write ? "Set" : "Would set"} ${set} · no IP ${noIp} · no geo ${noGeo}`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
