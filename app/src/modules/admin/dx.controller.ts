import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"

/**
 * DX (Developer Experience) admin controllers — rate-limit overrides,
 * API changelog, deprecation registry, request replay queue.
 */

const VALID_SUBJECT = ["api_key", "oauth_client"] as const
const VALID_CHANGE  = ["breaking", "feature", "fix", "deprecation", "security"] as const

// ---- Rate limit overrides ---------------------------------------------

export async function listRateLimits(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.rateLimitOverride.findMany({ orderBy: { updatedAt: "desc" }, take: 200 })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function upsertRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { subjectType, subjectId, requestsPerWindow, windowSeconds, reason, expiresAt } = req.body as Record<string, unknown>
    if (!VALID_SUBJECT.includes(subjectType as typeof VALID_SUBJECT[number])) throw badRequest(`subjectType ∈ ${VALID_SUBJECT.join("|")}`)
    if (typeof subjectId !== "string" || !subjectId.trim()) throw badRequest("subjectId required")
    const rpw = Number(requestsPerWindow), win = Number(windowSeconds)
    if (!Number.isInteger(rpw) || rpw < 1) throw badRequest("requestsPerWindow must be a positive integer")
    if (!Number.isInteger(win) || win < 1) throw badRequest("windowSeconds must be a positive integer")

    const row = await prisma.rateLimitOverride.upsert({
      where:  { subjectType_subjectId: { subjectType: subjectType as string, subjectId } },
      update: {
        requestsPerWindow: rpw, windowSeconds: win,
        reason:    typeof reason === "string" ? reason : null,
        expiresAt: typeof expiresAt === "string" ? new Date(expiresAt) : null,
      },
      create: {
        subjectType: subjectType as string, subjectId,
        requestsPerWindow: rpw, windowSeconds: win,
        reason:    typeof reason === "string" ? reason : null,
        expiresAt: typeof expiresAt === "string" ? new Date(expiresAt) : null,
        createdBy: actorId,
      },
    })
    await adminAuditR(req, res, {
      action: "rate_limit.override.upsert", targetType: "RateLimitOverride", targetId: row.id,
      metadata: { subjectType, subjectId, requestsPerWindow: rpw, windowSeconds: win },
    })
    res.status(200).json({ override: row })
  } catch (err) { next(err) }
}

export async function deleteRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.rateLimitOverride.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "rate_limit.override.delete", targetType: "RateLimitOverride", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

// ---- API changelog ----------------------------------------------------

export async function listChangelog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const type = typeof req.query.type === "string" ? req.query.type : undefined
    const data = await prisma.apiChangeLog.findMany({
      where: type ? { changeType: type } : {},
      orderBy: { publishedAt: "desc" }, take: 200,
    })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function createChangelog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { title, body, changeType, affects, publishedAt } = req.body as Record<string, unknown>
    if (typeof title !== "string" || !title.trim()) throw badRequest("title required")
    if (typeof body  !== "string" || !body.trim())  throw badRequest("body required")
    if (!VALID_CHANGE.includes(changeType as typeof VALID_CHANGE[number])) throw badRequest(`changeType ∈ ${VALID_CHANGE.join("|")}`)
    const row = await prisma.apiChangeLog.create({
      data: {
        title: title.trim(), body, changeType: changeType as string,
        affects: Array.isArray(affects) ? affects.map(String) : [],
        publishedAt: typeof publishedAt === "string" ? new Date(publishedAt) : new Date(),
        authorId:    actorId,
      },
    })
    await adminAuditR(req, res, {
      action: "changelog.create", targetType: "ApiChangeLog", targetId: row.id,
      metadata: { title, changeType },
    })
    res.status(200).json({ entry: row })
  } catch (err) { next(err) }
}

export async function deleteChangelog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.apiChangeLog.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "changelog.delete", targetType: "ApiChangeLog", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

// ---- Deprecations -----------------------------------------------------

export async function listDeprecations(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.deprecatedEndpoint.findMany({ orderBy: { sunsetAt: "asc" }, take: 200 })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function upsertDeprecation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { endpoint, sunsetAt, reason, replacement } = req.body as Record<string, unknown>
    if (typeof endpoint  !== "string" || !endpoint.trim()) throw badRequest("endpoint required")
    if (typeof sunsetAt  !== "string" || !sunsetAt.trim()) throw badRequest("sunsetAt required (ISO date)")
    const sunset = new Date(sunsetAt)
    if (isNaN(sunset.getTime())) throw badRequest("sunsetAt invalid")
    const row = await prisma.deprecatedEndpoint.upsert({
      where:  { endpoint },
      update: { sunsetAt: sunset, reason: typeof reason === "string" ? reason : null, replacement: typeof replacement === "string" ? replacement : null },
      create: { endpoint, sunsetAt: sunset, reason: typeof reason === "string" ? reason : null, replacement: typeof replacement === "string" ? replacement : null, createdBy: actorId },
    })
    await adminAuditR(req, res, {
      action: "deprecation.upsert", targetType: "DeprecatedEndpoint", targetId: row.id,
      metadata: { endpoint, sunsetAt },
    })
    res.status(200).json({ deprecation: row })
  } catch (err) { next(err) }
}

export async function deleteDeprecation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.deprecatedEndpoint.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "deprecation.delete", targetType: "DeprecatedEndpoint", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

// ---- Request captures (replay) ----------------------------------------

export async function listCaptures(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const endpoint = typeof req.query.endpoint === "string" ? req.query.endpoint : undefined
    const data = await prisma.requestCapture.findMany({
      where: endpoint ? { endpoint } : {},
      orderBy: { createdAt: "desc" }, take: 100,
    })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function deleteCapture(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.requestCapture.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "request_capture.delete", targetType: "RequestCapture", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}
