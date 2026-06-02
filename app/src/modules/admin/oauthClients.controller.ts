import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"
import { generateClientId, generateClientSecret, hash, isKnownScope, KNOWN_SCOPES } from "../../lib/oauth2"

export async function listClients(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.oauthClient.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { _count: { select: { accessTokens: true } } },
    })
    // Strip secret hash — never expose
    const sanitized = data.map(({ clientSecretHash, ...rest }) => rest)
    res.status(200).json({ data: sanitized, knownScopes: KNOWN_SCOPES })
  } catch (err) { next(err) }
}

export async function getClient(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const c = await prisma.oauthClient.findUnique({
      where: { id },
      include: {
        accessTokens: {
          orderBy: { createdAt: "desc" }, take: 20,
          select: { id: true, scopes: true, expiresAt: true, revokedAt: true, lastUsedAt: true, useCount: true, createdAt: true },
        },
      },
    })
    if (!c) throw notFound("Client not found")
    const { clientSecretHash, ...rest } = c
    res.status(200).json(rest)
  } catch (err) { next(err) }
}

export async function createClient(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string
    const { name, scopes, description, ownerEmail, redirectUris } = req.body as Record<string, unknown>
    if (typeof name !== "string" || name.trim().length === 0) throw badRequest("name required")
    const scopeList = Array.isArray(scopes) ? scopes.map(String) : []
    for (const s of scopeList) {
      if (!isKnownScope(s)) throw badRequest(`Unknown scope: ${s}`)
    }

    const clientId     = generateClientId()
    const clientSecret = generateClientSecret()

    const created = await prisma.oauthClient.create({
      data: {
        name:         name.trim(),
        clientId,
        clientSecretHash: hash(clientSecret),
        scopes:       scopeList,
        description:  typeof description  === "string" ? description  : null,
        ownerEmail:   typeof ownerEmail   === "string" ? ownerEmail   : null,
        redirectUris: Array.isArray(redirectUris) ? redirectUris.map(String) : [],
        createdBy:    actorId,
      },
    })

    await adminAuditR(req, res, {
      action: "oauth_client.create", targetType: "OauthClient", targetId: created.id,
      metadata: { name: created.name, scopes: created.scopes },
    })

    const { clientSecretHash, ...rest } = created
    // SECRET RETURNED ONCE
    res.status(200).json({
      client: rest,
      clientSecret,                        // <-- displayed once on the admin UI
      _warning: "Store this client_secret now — it will not be shown again.",
    })
  } catch (err) { next(err) }
}

export async function rotateSecret(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const c = await prisma.oauthClient.findUnique({ where: { id } })
    if (!c) throw notFound("Client not found")
    const clientSecret = generateClientSecret()
    await prisma.oauthClient.update({
      where: { id }, data: { clientSecretHash: hash(clientSecret) },
    })
    await adminAuditR(req, res, {
      action: "oauth_client.rotate_secret", targetType: "OauthClient", targetId: id,
      metadata: { name: c.name },
    })
    res.status(200).json({ clientSecret, _warning: "Store this new client_secret now — the old one is invalidated." })
  } catch (err) { next(err) }
}

export async function updateClient(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const c = await prisma.oauthClient.findUnique({ where: { id } })
    if (!c) throw notFound("Client not found")
    const { name, scopes, description, ownerEmail, redirectUris } = req.body as Record<string, unknown>
    if (Array.isArray(scopes)) {
      for (const s of scopes.map(String)) if (!isKnownScope(s)) throw badRequest(`Unknown scope: ${s}`)
    }
    const updated = await prisma.oauthClient.update({
      where: { id },
      data: {
        ...(typeof name        === "string" ? { name: name.trim() } : {}),
        ...(Array.isArray(scopes) ? { scopes: scopes.map(String) } : {}),
        ...(typeof description === "string" || description === null ? { description: description as string | null } : {}),
        ...(typeof ownerEmail  === "string" || ownerEmail  === null ? { ownerEmail:  ownerEmail  as string | null } : {}),
        ...(Array.isArray(redirectUris) ? { redirectUris: redirectUris.map(String) } : {}),
      },
    })
    await adminAuditR(req, res, {
      action: "oauth_client.update", targetType: "OauthClient", targetId: id,
      metadata: { fields: Object.keys(req.body as object) },
    })
    const { clientSecretHash, ...rest } = updated
    res.status(200).json({ client: rest })
  } catch (err) { next(err) }
}

export async function revokeClient(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const c = await prisma.oauthClient.findUnique({ where: { id } })
    if (!c) throw notFound("Client not found")
    if (c.revokedAt) { res.status(200).json({ ok: true }); return }
    await prisma.oauthClient.update({ where: { id }, data: { revokedAt: new Date() } })
    // Revoke all live tokens too
    await prisma.oauthAccessToken.updateMany({
      where: { clientId: id, revokedAt: null }, data: { revokedAt: new Date() },
    })
    await adminAuditR(req, res, {
      action: "oauth_client.revoke", targetType: "OauthClient", targetId: id,
      metadata: { name: c.name },
    })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}

export async function revokeToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tokenId = req.params.tokenId as string
    const t = await prisma.oauthAccessToken.findUnique({ where: { id: tokenId } })
    if (!t) throw notFound("Token not found")
    await prisma.oauthAccessToken.update({ where: { id: tokenId }, data: { revokedAt: new Date() } })
    await adminAuditR(req, res, {
      action: "oauth_token.revoke", targetType: "OauthAccessToken", targetId: tokenId,
      metadata: { clientId: t.clientId },
    })
    res.status(200).json({ ok: true })
  } catch (err) { next(err) }
}
