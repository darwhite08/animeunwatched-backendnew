import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"
import { invalidateSamlCache } from "../../lib/saml"

export async function listConfigs(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.samlConfig.findMany({ orderBy: [{ active: "desc" }, { updatedAt: "desc" }] })
    // Never return private keys — even to admins; rotation is the path forward
    const sanitized = rows.map(({ spPrivateKey, idpCertificate, ...rest }) => ({
      ...rest,
      idpCertificateFingerprint: idpCertificate ? sha1Fingerprint(idpCertificate) : null,
      hasSpPrivateKey: !!spPrivateKey,
    }))
    res.status(200).json({ data: sanitized })
  } catch (err) { next(err) }
}

export async function getConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const c = await prisma.samlConfig.findUnique({ where: { id: String(req.params.id) } })
    if (!c) throw notFound("Config not found")
    const { spPrivateKey, ...rest } = c
    res.status(200).json({ ...rest, hasSpPrivateKey: !!spPrivateKey })
  } catch (err) { next(err) }
}

export async function createConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const b = req.body as Record<string, unknown>
    const required = ["name", "idpEntityId", "idpSsoUrl", "idpCertificate", "spEntityId"]
    for (const k of required) {
      if (typeof b[k] !== "string" || !(b[k] as string).trim()) throw badRequest(`${k} required`)
    }
    const created = await prisma.samlConfig.create({
      data: {
        name:                String(b.name).trim(),
        idpEntityId:         String(b.idpEntityId).trim(),
        idpSsoUrl:           String(b.idpSsoUrl).trim(),
        idpSloUrl:           typeof b.idpSloUrl === "string" ? b.idpSloUrl.trim() : null,
        idpCertificate:      String(b.idpCertificate).trim(),
        spEntityId:          String(b.spEntityId).trim(),
        emailAttribute:      typeof b.emailAttribute    === "string" ? b.emailAttribute    : "email",
        displayNameAttr:     typeof b.displayNameAttr   === "string" ? b.displayNameAttr   : "displayName",
        autoProvision:       b.autoProvision !== false,
        signRequests:        b.signRequests === true,
        wantAssertionsSigned: b.wantAssertionsSigned !== false,
        spPrivateKey:        typeof b.spPrivateKey === "string" ? b.spPrivateKey : null,
        spCertificate:       typeof b.spCertificate === "string" ? b.spCertificate : null,
        createdBy:           actorId,
      },
    })
    invalidateSamlCache()
    await adminAuditR(req, res, {
      action: "saml.create", targetType: "SamlConfig", targetId: created.id,
      metadata: { name: created.name, idpEntityId: created.idpEntityId },
    })
    const { spPrivateKey, ...rest } = created
    res.status(200).json({ ...rest, hasSpPrivateKey: !!spPrivateKey })
  } catch (err) { next(err) }
}

export async function updateConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const existing = await prisma.samlConfig.findUnique({ where: { id } })
    if (!existing) throw notFound("Config not found")
    const b = req.body as Record<string, unknown>
    const data: Record<string, unknown> = {}
    for (const k of ["name","idpEntityId","idpSsoUrl","idpSloUrl","idpCertificate","spEntityId","emailAttribute","displayNameAttr","spPrivateKey","spCertificate"]) {
      if (typeof b[k] === "string") data[k] = b[k]
    }
    if (typeof b.autoProvision === "boolean")        data.autoProvision = b.autoProvision
    if (typeof b.signRequests  === "boolean")        data.signRequests  = b.signRequests
    if (typeof b.wantAssertionsSigned === "boolean") data.wantAssertionsSigned = b.wantAssertionsSigned

    const updated = await prisma.samlConfig.update({ where: { id }, data })
    invalidateSamlCache()
    await adminAuditR(req, res, {
      action: "saml.update", targetType: "SamlConfig", targetId: id,
      metadata: { fields: Object.keys(data) },
    })
    const { spPrivateKey, ...rest } = updated
    res.status(200).json({ ...rest, hasSpPrivateKey: !!spPrivateKey })
  } catch (err) { next(err) }
}

export async function activateConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const c = await prisma.samlConfig.findUnique({ where: { id } })
    if (!c) throw notFound("Config not found")
    // Single-active invariant: deactivate everything else first, then activate this one
    await prisma.$transaction([
      prisma.samlConfig.updateMany({ where: { active: true }, data: { active: false } }),
      prisma.samlConfig.update({ where: { id }, data: { active: true } }),
    ])
    invalidateSamlCache()
    await adminAuditR(req, res, {
      action: "saml.activate", targetType: "SamlConfig", targetId: id,
      metadata: { name: c.name },
    })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

export async function deactivateAll(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await prisma.samlConfig.updateMany({ where: { active: true }, data: { active: false } })
    invalidateSamlCache()
    await adminAuditR(req, res, { action: "saml.deactivate_all" })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

export async function deleteConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    await prisma.samlConfig.delete({ where: { id } }).catch(() => undefined)
    invalidateSamlCache()
    await adminAuditR(req, res, { action: "saml.delete", targetType: "SamlConfig", targetId: id })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

export async function listLoginEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.samlLoginEvent.findMany({ orderBy: { createdAt: "desc" }, take: 100 })
    const counters: Record<string, number> = {}
    for (const r of data) counters[r.outcome] = (counters[r.outcome] ?? 0) + 1
    res.status(200).json({ data, counters })
  } catch (err) { next(err) }
}

// Used for the "SP metadata" copy-to-clipboard on the admin UI
export async function getSpMetadataUrl(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const proto = (req.header("X-Forwarded-Proto") ?? "https").split(",")[0].trim()
    const host  = req.header("X-Forwarded-Host") ?? req.header("Host") ?? "api.kaiveron.com"
    res.status(200).json({
      metadataUrl: `${proto}://${host}/saml/metadata`,
      acsUrl:      `${proto}://${host}/saml/acs`,
      loginUrl:    `${proto}://${host}/saml/login`,
    })
  } catch (err) { next(err) }
}

function sha1Fingerprint(pem: string): string {
  const stripped = pem.replace(/-----BEGIN CERTIFICATE-----/g, "").replace(/-----END CERTIFICATE-----/g, "").replace(/\s+/g, "")
  if (!stripped) return ""
  const der = Buffer.from(stripped, "base64")
  return require("node:crypto").createHash("sha1").update(der).digest("hex").match(/.{2}/g)?.join(":") ?? ""
}
