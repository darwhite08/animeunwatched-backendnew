import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"
import { toCsv } from "../../lib/csv"

/**
 * Generic bulk export — admin picks a resource + format, we stream the
 * result. Hard-capped at 10k rows for synchronous responses; anything
 * bigger should land in ExportJob (TODO when we wire object storage).
 *
 * Resource registry is closed: only the listed keys can be exported.
 * Each entry pulls a flattened row shape suitable for analyst-friendly
 * CSV; sensitive fields (passwordHash, secret hashes, etc.) are dropped.
 */

const MAX_ROWS = 10_000

interface ExportSource {
  key:        string
  description: string
  fetch:      (opts: { limit: number; since?: Date }) => Promise<Array<Record<string, unknown>>>
}

const SOURCES: Record<string, ExportSource> = {
  users: {
    key: "users", description: "All users (without passwords/secrets)",
    fetch: async ({ limit }) => {
      const rows = await prisma.user.findMany({
        take: limit, orderBy: { createdAt: "desc" },
        select: { id: true, email: true, username: true, displayName: true, role: true, reputation: true, isBanned: true, isShadowBanned: true, createdAt: true },
      })
      return rows
    },
  },
  tickets: {
    key: "tickets", description: "All support tickets",
    fetch: async ({ limit }) => {
      return prisma.ticket.findMany({
        take: limit, orderBy: { createdAt: "desc" },
        select: { id: true, number: true, subject: true, status: true, priority: true, category: true, email: true, userId: true, assigneeId: true, createdAt: true, resolvedAt: true },
      })
    },
  },
  incidents: {
    key: "incidents", description: "Incident lifecycle",
    fetch: async ({ limit }) => {
      return prisma.incident.findMany({
        take: limit, orderBy: { startedAt: "desc" },
        select: { id: true, title: true, severity: true, status: true, category: true, startedAt: true, resolvedAt: true, rootCause: true },
      })
    },
  },
  audit: {
    key: "audit", description: "Admin audit log (last 30d)",
    fetch: async ({ limit, since }) => {
      return prisma.auditLog.findMany({
        where: since ? { createdAt: { gte: since } } : {},
        take: limit, orderBy: { createdAt: "desc" },
        select: { id: true, actorId: true, action: true, targetType: true, targetId: true, ipAddress: true, createdAt: true },
      })
    },
  },
  saml_logins: {
    key: "saml_logins", description: "SAML login attempts",
    fetch: async ({ limit, since }) => {
      return prisma.samlLoginEvent.findMany({
        where: since ? { createdAt: { gte: since } } : {},
        take: limit, orderBy: { createdAt: "desc" },
        select: { id: true, configId: true, userId: true, email: true, outcome: true, ipAddress: true, createdAt: true },
      })
    },
  },
  anomalies: {
    key: "anomalies", description: "Anomaly detections",
    fetch: async ({ limit, since }) => {
      return prisma.anomalyEvent.findMany({
        where: since ? { createdAt: { gte: since } } : {},
        take: limit, orderBy: { createdAt: "desc" },
        select: { id: true, kind: true, severity: true, userId: true, ipAddress: true, acknowledgedAt: true, createdAt: true },
      })
    },
  },
  oauth_clients: {
    key: "oauth_clients", description: "Registered OAuth clients (no secrets)",
    fetch: async ({ limit }) => {
      return prisma.oauthClient.findMany({
        take: limit, orderBy: { createdAt: "desc" },
        select: { id: true, name: true, clientId: true, type: true, scopes: true, revokedAt: true, lastUsedAt: true, createdAt: true },
      })
    },
  },
}

export async function listExportSources(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json({ data: Object.values(SOURCES).map(s => ({ key: s.key, description: s.description })) })
  } catch (err) { next(err) }
}

export async function exportResource(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const resource = req.params.resource as string
    const source = SOURCES[resource]
    if (!source) throw badRequest(`Unknown resource. Valid: ${Object.keys(SOURCES).join(", ")}`)
    const format = (typeof req.query.format === "string" ? req.query.format : "csv").toLowerCase()
    if (format !== "csv" && format !== "json") throw badRequest("format must be csv or json")
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30))
    const since = new Date(Date.now() - days * 24 * 60 * 60_000)
    const limit = Math.min(MAX_ROWS, Math.max(1, Number(req.query.limit) || MAX_ROWS))

    const rows = await source.fetch({ limit, since })

    await adminAuditR(req, res, {
      action: "export.run", targetType: "ExportSource", targetId: resource,
      metadata: { rowCount: rows.length, format, days },
    })

    const filename = `${resource}-${new Date().toISOString().slice(0,10)}.${format}`
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
    if (format === "json") {
      res.setHeader("Content-Type", "application/json")
      res.status(200).json({ resource, exportedAt: new Date().toISOString(), rowCount: rows.length, data: rows })
    } else {
      res.setHeader("Content-Type", "text/csv; charset=utf-8")
      // Flatten BigInt + Date to friendly types
      const flat = rows.map(r => {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(r)) {
          if (typeof v === "bigint") out[k] = v.toString()
          else if (v instanceof Date) out[k] = v.toISOString()
          else out[k] = v
        }
        return out
      })
      res.status(200).send(toCsv(flat))
    }
  } catch (err) { next(err) }
}
