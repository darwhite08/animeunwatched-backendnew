import { Router } from "express"
import type { Request, Response } from "express"
import crypto from "node:crypto"
import { prisma } from "../../config/prisma"
import { requireOauth } from "../../middlewares/oauth.middleware"
import {
  userToScim, listResponse, scimError, parseFilter, applyPatchOps,
  serviceProviderConfig, resourceTypes, schemas,
  type PatchOp,
} from "../../lib/scim"

export const scimRouter = Router()

// Every SCIM call needs the `scim` scope on an OAuth client_credentials token
scimRouter.use(requireOauth({ scope: "scim" }))

// All responses MUST use the SCIM content type. Set globally on this router.
scimRouter.use((_req, res, next) => {
  res.setHeader("Content-Type", "application/scim+json")
  next()
})

function baseUrlFor(req: Request): string {
  const proto = (req.header("X-Forwarded-Proto") ?? req.protocol).split(",")[0].trim()
  const host  = req.header("X-Forwarded-Host") ?? req.header("Host") ?? "localhost"
  return `${proto}://${host}/scim/v2`
}

function send(res: Response, e: { body: Record<string, unknown>; status: number }): void {
  res.status(e.status).json(e.body)
}

// --- Discovery ----------------------------------------------------------

scimRouter.get("/ServiceProviderConfig", (req, res) => {
  res.status(200).json(serviceProviderConfig(baseUrlFor(req)))
})
scimRouter.get("/ResourceTypes",  (req, res) => res.status(200).json(resourceTypes(baseUrlFor(req))))
scimRouter.get("/Schemas",        (req, res) => res.status(200).json(schemas(baseUrlFor(req))))

// --- Users --------------------------------------------------------------

// List + filter
scimRouter.get("/Users", async (req, res) => {
  try {
    const filter      = typeof req.query.filter === "string" ? req.query.filter : undefined
    const startIndex  = Math.max(1, Number(req.query.startIndex) || 1)
    const count       = Math.min(200, Math.max(0, Number(req.query.count) || 100))

    let where: Record<string, unknown>
    try {
      where = parseFilter(filter) ?? {}
    } catch (err) {
      return send(res, scimError(400, (err as Error).message, "invalidFilter"))
    }

    const [users, totalResults] = await Promise.all([
      prisma.user.findMany({
        where, skip: startIndex - 1, take: count,
        orderBy: { createdAt: "asc" },
        include: { scimSubject: true },
      }),
      prisma.user.count({ where }),
    ])
    const base = baseUrlFor(req)
    const resources = users.map(u => userToScim(u, u.scimSubject?.externalId ?? null, base))
    res.status(200).json(listResponse(resources, totalResults, startIndex, resources.length))
  } catch (err) {
    console.error("[scim] list failed:", err)
    send(res, scimError(500, "Internal error"))
  }
})

// Get one
scimRouter.get("/Users/:id", async (req, res) => {
  try {
    const u = await prisma.user.findUnique({
      where: { id: req.params.id }, include: { scimSubject: true },
    })
    if (!u) return send(res, scimError(404, "User not found"))
    res.status(200).json(userToScim(u, u.scimSubject?.externalId ?? null, baseUrlFor(req)))
  } catch (err) {
    console.error("[scim] get failed:", err)
    send(res, scimError(500, "Internal error"))
  }
})

// Create — provisioning from the IdP
scimRouter.post("/Users", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const userName    = typeof body.userName    === "string" ? body.userName    : undefined
    const displayName = typeof body.displayName === "string" ? body.displayName : userName
    const externalId  = typeof body.externalId  === "string" ? body.externalId  : null
    const emails      = Array.isArray(body.emails) ? body.emails as Array<{ value?: string; primary?: boolean }> : []
    const email       = (emails.find(e => e.primary)?.value ?? emails[0]?.value ?? "").toString()
    const active      = body.active === false ? false : true

    if (!userName)    return send(res, scimError(400, "userName is required", "invalidValue"))
    if (!displayName) return send(res, scimError(400, "displayName is required", "invalidValue"))
    if (!email)       return send(res, scimError(400, "At least one email is required", "invalidValue"))

    // Uniqueness check — let SCIM clients see the SCIM-shaped 409
    const existingByEmail = await prisma.user.findUnique({ where: { email } })
    if (existingByEmail) return send(res, scimError(409, `User with email ${email} already exists`, "uniqueness"))
    const existingByUsername = await prisma.user.findUnique({ where: { username: userName } })
    if (existingByUsername) return send(res, scimError(409, `User with userName ${userName} already exists`, "uniqueness"))
    if (externalId) {
      const existingByExt = await prisma.scimSubject.findUnique({ where: { externalId } })
      if (existingByExt) return send(res, scimError(409, `externalId already mapped`, "uniqueness"))
    }

    // Random unguessable password — SCIM users log in via password reset
    // flow until SAML/OIDC lands. The hash is opaque + intentional.
    const placeholderHash = "scim_provisioned:" + crypto.randomBytes(48).toString("hex")

    const oauthCtx = (res.locals as { oauth?: { client: { id: string; name: string } } }).oauth

    const created = await prisma.user.create({
      data: {
        email,
        username:    userName,
        displayName,
        passwordHash: placeholderHash,
        isBanned:    !active,
        bannedReason: !active ? "Provisioned as inactive by SCIM" : null,
      },
    })

    if (externalId) {
      await prisma.scimSubject.create({
        data: {
          externalId, userId: created.id,
          idpClientId: oauthCtx?.client.id,
          meta: body as never,
        },
      })
    }

    res.status(201).setHeader("Location", `${baseUrlFor(req)}/Users/${created.id}`)
    res.json(userToScim(created, externalId, baseUrlFor(req)))
  } catch (err) {
    console.error("[scim] create failed:", err)
    send(res, scimError(500, "Internal error"))
  }
})

// PATCH — primarily used for active=false (deactivation) by Okta/Azure
scimRouter.patch("/Users/:id", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { Operations?: PatchOp[] }
    if (!Array.isArray(body.Operations)) return send(res, scimError(400, "Operations array required", "invalidSyntax"))

    let delta
    try { delta = applyPatchOps(body.Operations) }
    catch (err) { return send(res, scimError(400, (err as Error).message, "invalidSyntax")) }

    const existing = await prisma.user.findUnique({ where: { id: req.params.id } })
    if (!existing) return send(res, scimError(404, "User not found"))

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        ...(typeof delta.isBanned    === "boolean" ? { isBanned: delta.isBanned, ...(delta.isBanned ? { bannedReason: "Deactivated via SCIM" } : { bannedReason: null }) } : {}),
        ...(typeof delta.displayName === "string"  ? { displayName: delta.displayName } : {}),
        ...(typeof delta.email       === "string"  ? { email:       delta.email       } : {}),
      },
      include: { scimSubject: true },
    })

    res.status(200).json(userToScim(updated, updated.scimSubject?.externalId ?? null, baseUrlFor(req)))
  } catch (err) {
    console.error("[scim] patch failed:", err)
    send(res, scimError(500, "Internal error"))
  }
})

// PUT — full replace; least-used by IdPs but mandatory per spec
scimRouter.put("/Users/:id", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const displayName = typeof body.displayName === "string" ? body.displayName : undefined
    const active      = body.active === false ? false : true
    const emails      = Array.isArray(body.emails) ? body.emails as Array<{ value?: string; primary?: boolean }> : []
    const email       = (emails.find(e => e.primary)?.value ?? emails[0]?.value ?? "").toString()

    const existing = await prisma.user.findUnique({ where: { id: req.params.id } })
    if (!existing) return send(res, scimError(404, "User not found"))

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        ...(displayName ? { displayName } : {}),
        ...(email       ? { email }       : {}),
        isBanned: !active,
        bannedReason: !active ? "Deactivated via SCIM" : null,
      },
      include: { scimSubject: true },
    })
    res.status(200).json(userToScim(updated, updated.scimSubject?.externalId ?? null, baseUrlFor(req)))
  } catch (err) {
    console.error("[scim] put failed:", err)
    send(res, scimError(500, "Internal error"))
  }
})

// DELETE — IdPs send this on user deprovisioning. We deactivate rather
// than hard-delete so the account can be reactivated and so we retain
// the audit trail of their contributions.
scimRouter.delete("/Users/:id", async (req, res) => {
  try {
    const existing = await prisma.user.findUnique({ where: { id: req.params.id } })
    if (!existing) return send(res, scimError(404, "User not found"))
    await prisma.user.update({
      where: { id: req.params.id },
      data:  { isBanned: true, bannedReason: "Deprovisioned via SCIM" },
    })
    // Also revoke their refresh tokens so existing sessions die immediately
    await prisma.refreshToken.deleteMany({ where: { userId: req.params.id } })
    res.status(204).end()
  } catch (err) {
    console.error("[scim] delete failed:", err)
    send(res, scimError(500, "Internal error"))
  }
})
