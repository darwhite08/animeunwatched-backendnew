import { prisma } from "../config/prisma"
import { raiseAlert } from "../lib/raiseAlert"

/**
 * Watches BackupRecord history. If no successful backup of a critical
 * kind ("db", "uploads") has happened in the last RPO_HOURS, raise an
 * AdminAlert. Idempotent — only raises one alert per missing kind per
 * 24h window.
 */

const RPO_HOURS = 24
const CRITICAL_KINDS = ["db", "uploads"] as const

export async function backupHeartbeat(): Promise<{ missing: string[] }> {
  const cutoff = new Date(Date.now() - RPO_HOURS * 60 * 60_000)
  const missing: string[] = []
  for (const kind of CRITICAL_KINDS) {
    const recent = await prisma.backupRecord.findFirst({
      where: { kind, completedAt: { gte: cutoff } },
      orderBy: { completedAt: "desc" },
    })
    if (recent) continue
    missing.push(kind)
    // Dedupe — only raise if there's no open critical alert with the same title in the last 24h
    const already = await prisma.adminAlert.findFirst({
      where: {
        title:     `Backup missing: ${kind}`,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) },
      },
    })
    if (already) continue
    await raiseAlert({
      severity: "critical", category: "backup",
      title: `Backup missing: ${kind}`, link: "/backups",
      metadata: { kind, rpoHours: RPO_HOURS },
    })
  }
  return { missing }
}
