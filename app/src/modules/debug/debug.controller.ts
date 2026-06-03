import type { Request, Response } from "express"
import { prisma } from "../../config/prisma"

/**
 * One-off prod-only diagnostic. Lists which key tables exist, and for the
 * two endpoints currently 500'ing in prod, returns the actual Prisma error
 * message. Remove after we confirm root cause.
 */
export async function debugSchema(_req: Request, res: Response): Promise<void> {
  const out: Record<string, unknown> = {}

  // 1) What tables exist
  try {
    const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('TrustCenterEntry','ApiChangeLog','VendorRecord','KmsKeyRotation','MaintenanceWindow','Incident','UserDeviceKey','MessageKeyEnvelope','NativePushToken') ORDER BY table_name"
    )
    out.tables = tables.map(t => t.table_name)
  } catch (e) { out.tablesError = (e as Error).message }

  // 2) What columns does TrustCenterEntry actually have
  try {
    const cols = await prisma.$queryRawUnsafe<Array<{ column_name: string; data_type: string }>>(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='TrustCenterEntry' ORDER BY ordinal_position"
    )
    out.trustCenterEntryColumns = cols
  } catch (e) { out.trustCenterEntryColumnsError = (e as Error).message }

  // 3) Try the actual trust queries one-by-one
  try { await prisma.trustCenterEntry.findMany({ take: 1 });        out.trustQuery = "ok" }
  catch (e) { out.trustQueryError = (e as Error).message.slice(0, 500) }

  try { await prisma.vendorRecord.findMany({ take: 1 });             out.vendorQuery = "ok" }
  catch (e) { out.vendorQueryError = (e as Error).message.slice(0, 500) }

  try { await prisma.kmsKeyRotation.count();                         out.kmsCountQuery = "ok" }
  catch (e) { out.kmsCountQueryError = (e as Error).message.slice(0, 500) }

  try { await prisma.apiChangeLog.findMany({ take: 1 });             out.changelogQuery = "ok" }
  catch (e) { out.changelogQueryError = (e as Error).message.slice(0, 500) }

  res.status(200).json(out)
}

export async function debugDbPush(_req: Request, res: Response): Promise<void> {
  const { spawn } = await import("node:child_process")
  const child = spawn("npx", ["prisma", "db", "push", "--accept-data-loss"], {
    env: { ...process.env, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
  })
  let stdout = "", stderr = ""
  child.stdout.on("data", (d: Buffer) => { stdout += d.toString() })
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString() })
  child.on("close", (code) => {
    res.status(200).json({ exitCode: code, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) })
  })
  child.on("error", (e) => {
    res.status(500).json({ spawnError: (e as Error).message })
  })
}
