import type { Request, Response, NextFunction } from "express"
import crypto from "node:crypto"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"

const VALID_RTBF_STATUS = ["pending", "verified", "executing", "completed", "rejected"] as const

// ---- Consent records --------------------------------------------------

export async function listConsent(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const purpose = typeof req.query.purpose === "string" ? req.query.purpose : undefined
    const userId  = typeof req.query.userId  === "string" ? req.query.userId  : undefined
    const data = await prisma.consentRecord.findMany({
      where: { ...(purpose ? { purpose } : {}), ...(userId ? { userId } : {}) },
      orderBy: { givenAt: "desc" }, take: 200,
    })
    const counters: Record<string, { given: number; withdrawn: number }> = {}
    for (const r of data) {
      counters[r.purpose] = counters[r.purpose] ?? { given: 0, withdrawn: 0 }
      if (r.withdrawnAt) counters[r.purpose].withdrawn++
      else                counters[r.purpose].given++
    }
    res.status(200).json({ data, counters })
  } catch (err) { next(err) }
}

// ---- RTBF queue --------------------------------------------------------

export async function listRtbf(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.rtbfRequest.findMany({ orderBy: { requestedAt: "desc" }, take: 200 })
    const counters: Record<string, number> = {}
    for (const r of data) counters[r.status] = (counters[r.status] ?? 0) + 1
    res.status(200).json({ data, counters })
  } catch (err) { next(err) }
}

export async function createRtbf(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { userId, email } = req.body as Record<string, unknown>
    if (typeof userId !== "string" || !userId.trim()) throw badRequest("userId required")
    if (typeof email !== "string"  || !email.trim())  throw badRequest("email required")
    const token = crypto.randomBytes(32).toString("hex")
    const row = await prisma.rtbfRequest.create({
      data: {
        userId, email,
        verificationTokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      },
    })
    await adminAuditR(req, res, {
      action: "rtbf.create", targetType: "RtbfRequest", targetId: row.id,
      metadata: { userId, email, createdBy: actorId },
    })
    // In real flow the token would be emailed; we surface it once to the admin.
    res.status(200).json({ request: row, verificationToken: token, _warning: "Send this token to the requester. Will not be shown again." })
  } catch (err) { next(err) }
}

export async function reviewRtbf(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const id = req.params.id as string
    const { status, rejectedReason } = req.body as Record<string, unknown>
    if (!VALID_RTBF_STATUS.includes(status as typeof VALID_RTBF_STATUS[number])) throw badRequest(`status ∈ ${VALID_RTBF_STATUS.join("|")}`)
    const existing = await prisma.rtbfRequest.findUnique({ where: { id } })
    if (!existing) throw notFound("Request not found")
    const data: Record<string, unknown> = { status: status as string }
    if (status === "rejected") data.rejectedReason = typeof rejectedReason === "string" ? rejectedReason : null
    if (status === "completed") { data.executedAt = new Date(); data.executorId = actorId }
    if (status === "verified")  data.verifiedAt = new Date()
    const updated = await prisma.rtbfRequest.update({ where: { id }, data })
    await adminAuditR(req, res, {
      action: `rtbf.${status}`, targetType: "RtbfRequest", targetId: id,
      metadata: { userId: existing.userId, email: existing.email },
    })
    res.status(200).json({ request: updated })
  } catch (err) { next(err) }
}

// ---- Vendor register ---------------------------------------------------

export async function listVendors(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.vendorRecord.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function upsertVendor(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const id = typeof req.params.id === "string" ? req.params.id : undefined
    const { name, url, category, dataAccessed, region, dpaUrl, contactEmail, notes } = req.body as Record<string, unknown>
    if (typeof name !== "string" || !name.trim())     throw badRequest("name required")
    if (typeof url  !== "string" || !url.trim())      throw badRequest("url required")
    if (typeof category !== "string" || !category.trim()) throw badRequest("category required")
    const data = {
      name: name.trim(), url: url.trim(), category: category.trim(),
      dataAccessed: Array.isArray(dataAccessed) ? dataAccessed.map(String) : [],
      region:       typeof region       === "string" ? region : null,
      dpaUrl:       typeof dpaUrl       === "string" ? dpaUrl : null,
      contactEmail: typeof contactEmail === "string" ? contactEmail : null,
      notes:        typeof notes        === "string" ? notes : null,
      reviewedAt:   new Date(),
      reviewedBy:   actorId,
    }
    const row = id
      ? await prisma.vendorRecord.update({ where: { id }, data })
      : await prisma.vendorRecord.create({ data })
    await adminAuditR(req, res, {
      action: id ? "vendor.update" : "vendor.create", targetType: "VendorRecord", targetId: row.id,
      metadata: { name, category },
    })
    res.status(200).json({ vendor: row })
  } catch (err) { next(err) }
}

export async function deleteVendor(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.vendorRecord.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "vendor.delete", targetType: "VendorRecord", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

// ---- KMS rotation ------------------------------------------------------

export async function listKms(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.kmsKeyRotation.findMany({ orderBy: { nextDueAt: "asc" } })
    const now = new Date()
    const overdue = data.filter(d => d.nextDueAt < now).length
    res.status(200).json({ data, overdue })
  } catch (err) { next(err) }
}

export async function upsertKms(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { keyAlias, provider, algorithm, lastRotatedAt, nextDueAt, notes } = req.body as Record<string, unknown>
    if (typeof keyAlias !== "string" || !keyAlias.trim()) throw badRequest("keyAlias required")
    if (typeof provider !== "string" || !provider.trim()) throw badRequest("provider required")
    if (typeof lastRotatedAt !== "string") throw badRequest("lastRotatedAt required")
    if (typeof nextDueAt     !== "string") throw badRequest("nextDueAt required")
    const row = await prisma.kmsKeyRotation.upsert({
      where:  { keyAlias },
      update: {
        provider,
        algorithm: typeof algorithm === "string" ? algorithm : null,
        lastRotatedAt: new Date(lastRotatedAt),
        nextDueAt: new Date(nextDueAt),
        notes: typeof notes === "string" ? notes : null,
        rotatedBy: actorId,
      },
      create: {
        keyAlias, provider,
        algorithm: typeof algorithm === "string" ? algorithm : null,
        lastRotatedAt: new Date(lastRotatedAt),
        nextDueAt: new Date(nextDueAt),
        notes: typeof notes === "string" ? notes : null,
        rotatedBy: actorId,
      },
    })
    await adminAuditR(req, res, {
      action: "kms.upsert", targetType: "KmsKeyRotation", targetId: row.id,
      metadata: { keyAlias, provider },
    })
    res.status(200).json({ key: row })
  } catch (err) { next(err) }
}

export async function deleteKms(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.kmsKeyRotation.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "kms.delete", targetType: "KmsKeyRotation", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}
