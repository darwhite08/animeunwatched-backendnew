import { PutObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { prisma } from "../config/prisma"
import { toCsv } from "./csv"
import { env } from "../config/env"

/**
 * Async export worker. Picks up pending ExportJob rows, runs the same
 * resource fetchers used by the sync export, but writes to object
 * storage instead of streaming back. Marked completed with a fileLocation
 * that the admin UI swaps for a 1-hour signed URL on demand.
 *
 * Reuses the same SOURCES registry indirectly by re-fetching via Prisma —
 * keeping the worker decoupled from the sync controller so the safelist
 * stays as the single source of truth.
 */

const MAX_ROWS = 1_000_000   // async exports lift the sync cap; cap at 1M for now

type SourceFn = (limit: number, since: Date) => Promise<Array<Record<string, unknown>>>

const ASYNC_SOURCES: Record<string, SourceFn> = {
  users: async (limit) => prisma.user.findMany({
    take: limit, orderBy: { createdAt: "desc" },
    select: { id: true, email: true, username: true, displayName: true, role: true, reputation: true, isBanned: true, createdAt: true },
  }),
  tickets: async (limit) => prisma.ticket.findMany({
    take: limit, orderBy: { createdAt: "desc" },
    select: { id: true, number: true, subject: true, status: true, priority: true, email: true, userId: true, createdAt: true, resolvedAt: true },
  }),
  audit: async (limit, since) => prisma.auditLog.findMany({
    where: { createdAt: { gte: since } }, take: limit, orderBy: { createdAt: "desc" },
    select: { id: true, actorId: true, action: true, targetType: true, targetId: true, ipAddress: true, createdAt: true },
  }),
}

function bucketAndClient(): { bucket: string; client: S3Client; publicUrl: string } | null {
  if (env.S3_BUCKET && env.S3_REGION) {
    return {
      bucket: env.S3_BUCKET,
      client: new S3Client({ region: env.S3_REGION }),
      publicUrl: env.S3_PUBLIC_URL ?? `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com`,
    }
  }
  return null
}

/** Picks up to N pending jobs and runs them. Called by the scheduler. */
export async function runExportJobs(limit = 3): Promise<{ processed: number }> {
  const backend = bucketAndClient()
  if (!backend) {
    // No storage configured — leave jobs pending; surface in admin UI
    return { processed: 0 }
  }
  const jobs = await prisma.exportJob.findMany({
    where: { status: "pending" }, orderBy: { createdAt: "asc" }, take: limit,
  })
  let processed = 0
  for (const job of jobs) {
    await prisma.exportJob.update({ where: { id: job.id }, data: { status: "running", startedAt: new Date() } })
    try {
      const src = ASYNC_SOURCES[job.resource]
      if (!src) throw new Error(`Unknown resource: ${job.resource}`)
      const filters = (job.filtersJson ?? {}) as { days?: number; limit?: number }
      const since = new Date(Date.now() - (filters.days ?? 30) * 24 * 60 * 60_000)
      const rows = await src(Math.min(filters.limit ?? MAX_ROWS, MAX_ROWS), since)

      const body = job.format === "json"
        ? Buffer.from(JSON.stringify(rows), "utf8")
        : Buffer.from(toCsv(rows.map(r => {
            const out: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(r)) {
              if (typeof v === "bigint") out[k] = v.toString()
              else if (v instanceof Date) out[k] = v.toISOString()
              else out[k] = v
            }
            return out
          })), "utf8")
      const key = `exports/${job.resource}/${job.id}.${job.format}`
      await backend.client.send(new PutObjectCommand({
        Bucket: backend.bucket, Key: key, Body: body,
        ContentType: job.format === "json" ? "application/json" : "text/csv",
      }))
      await prisma.exportJob.update({
        where: { id: job.id },
        data:  { status: "completed", completedAt: new Date(), rowCount: rows.length, fileLocation: `s3://${backend.bucket}/${key}` },
      })
      processed++
    } catch (err) {
      await prisma.exportJob.update({
        where: { id: job.id },
        data:  { status: "failed", completedAt: new Date(), errorDetail: (err as Error).message },
      })
      console.error("[exportRunner]", job.resource, "failed:", err)
    }
  }
  return { processed }
}

/** Resolves an ExportJob.fileLocation (s3://bucket/key) to a 1-hour signed URL. */
export async function signExport(fileLocation: string): Promise<string | null> {
  const backend = bucketAndClient()
  if (!backend) return null
  const m = /^s3:\/\/[^/]+\/(.+)$/.exec(fileLocation)
  if (!m) return null
  const url = await getSignedUrl(backend.client, new GetObjectCommand({ Bucket: backend.bucket, Key: m[1] }), { expiresIn: 3600 })
  return url
}
