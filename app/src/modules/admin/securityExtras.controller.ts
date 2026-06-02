import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"
import { encryptSecret } from "../../lib/vault"

const VALID_SUBJECT = ["api_key", "oauth_client", "user"] as const
const VALID_SEV     = ["sev1", "sev2", "sev3"] as const

// ---- IP allowlist -----------------------------------------------------

export async function listAllowlist(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.ipAllowlistEntry.findMany({ orderBy: { createdAt: "desc" }, take: 500 })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function createAllowlist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { subjectType, subjectId, cidr, description } = req.body as Record<string, unknown>
    if (!VALID_SUBJECT.includes(subjectType as typeof VALID_SUBJECT[number])) throw badRequest(`subjectType ∈ ${VALID_SUBJECT.join("|")}`)
    if (typeof subjectId !== "string" || !subjectId.trim()) throw badRequest("subjectId required")
    if (typeof cidr      !== "string" || !cidr.trim())      throw badRequest("cidr required")
    if (!/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(cidr) && !/^[0-9a-f:]+(\/\d{1,3})?$/i.test(cidr)) throw badRequest("cidr must be IPv4 or IPv6 CIDR")
    const row = await prisma.ipAllowlistEntry.create({
      data: {
        subjectType: subjectType as string, subjectId, cidr,
        description: typeof description === "string" ? description : null,
        createdBy:   actorId,
      },
    })
    await adminAuditR(req, res, {
      action: "ip_allowlist.create", targetType: "IpAllowlistEntry", targetId: row.id,
      metadata: { subjectType, subjectId, cidr },
    })
    res.status(200).json({ entry: row })
  } catch (err) { next(err) }
}

export async function deleteAllowlist(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.ipAllowlistEntry.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "ip_allowlist.delete", targetType: "IpAllowlistEntry", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

// ---- Vault -------------------------------------------------------------

export async function listVault(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.vaultEntry.findMany({ orderBy: { name: "asc" } })
    // Never return plaintext (or even ciphertext) — admins see only meta.
    const sanitized = rows.map(({ ciphertextB64, ivB64, authTagB64, ...rest }) => rest)
    res.status(200).json({ data: sanitized })
  } catch (err) { next(err) }
}

export async function upsertVault(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { name, category, plaintext, notes, rotationDueAt } = req.body as Record<string, unknown>
    if (typeof name      !== "string" || !name.trim())      throw badRequest("name required")
    if (typeof category  !== "string" || !category.trim())  throw badRequest("category required")
    if (typeof plaintext !== "string" || !plaintext.length) throw badRequest("plaintext required")
    const enc = encryptSecret(plaintext)
    const row = await prisma.vaultEntry.upsert({
      where:  { name },
      update: {
        category, ciphertextB64: enc.ciphertextB64, ivB64: enc.ivB64, authTagB64: enc.authTagB64,
        notes: typeof notes === "string" ? notes : null,
        rotationDueAt: typeof rotationDueAt === "string" ? new Date(rotationDueAt) : null,
        rotatedAt: new Date(),
        rotatedBy: actorId,
      },
      create: {
        name, category, ciphertextB64: enc.ciphertextB64, ivB64: enc.ivB64, authTagB64: enc.authTagB64,
        notes: typeof notes === "string" ? notes : null,
        rotationDueAt: typeof rotationDueAt === "string" ? new Date(rotationDueAt) : null,
      },
    })
    await adminAuditR(req, res, {
      action: "vault.upsert", targetType: "VaultEntry", targetId: row.id,
      metadata: { name, category },
    })
    const { ciphertextB64, ivB64, authTagB64, ...rest } = row
    res.status(200).json({ entry: rest })
  } catch (err) { next(err) }
}

export async function deleteVault(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.vaultEntry.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "vault.delete", targetType: "VaultEntry", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

// ---- DR runbooks ------------------------------------------------------

export async function listRunbooks(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const category = typeof req.query.category === "string" ? req.query.category : undefined
    const data = await prisma.drRunbook.findMany({
      where: category ? { triggerCategory: category } : {},
      orderBy: [{ severity: "asc" }, { title: "asc" }],
    })
    res.status(200).json({ data })
  } catch (err) { next(err) }
}

export async function upsertRunbook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const id = typeof req.params.id === "string" ? req.params.id : undefined
    const { title, triggerCategory, severity, body, expectedDurationMinutes, ownerEmail } = req.body as Record<string, unknown>
    if (typeof title           !== "string") throw badRequest("title required")
    if (typeof triggerCategory !== "string") throw badRequest("triggerCategory required")
    if (typeof body            !== "string") throw badRequest("body required")
    if (!VALID_SEV.includes(severity as typeof VALID_SEV[number])) throw badRequest(`severity ∈ ${VALID_SEV.join("|")}`)
    const data = {
      title: title.trim(), triggerCategory: triggerCategory.trim(), severity: severity as string, body,
      expectedDurationMinutes: typeof expectedDurationMinutes === "number" ? expectedDurationMinutes : null,
      ownerEmail:              typeof ownerEmail              === "string" ? ownerEmail : null,
      reviewedAt:              new Date(),
      reviewedBy:              actorId,
    }
    const row = id
      ? await prisma.drRunbook.update({ where: { id }, data })
      : await prisma.drRunbook.create({ data })
    await adminAuditR(req, res, {
      action: id ? "runbook.update" : "runbook.create", targetType: "DrRunbook", targetId: row.id,
      metadata: { title, severity },
    })
    res.status(200).json({ runbook: row })
  } catch (err) { next(err) }
}

export async function deleteRunbook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.drRunbook.delete({ where: { id } }).catch(() => undefined)
    await adminAuditR(req, res, { action: "runbook.delete", targetType: "DrRunbook", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}
