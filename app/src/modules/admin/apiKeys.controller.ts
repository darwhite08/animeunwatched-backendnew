import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { adminAudit, ipFromReq, uaFromReq } from "../../lib/adminAudit";

/**
 * M12 — API keys. Issued for partner / programmatic access. The raw key is
 * returned ONCE; only its SHA-256 hash + first 8 chars are stored.
 * Scope strings are space-separated, e.g. "read:users write:posts".
 */
function generateKey(): { raw: string; hash: string; prefix: string } {
  const raw = "kvr_" + crypto.randomBytes(28).toString("base64url");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash, prefix: raw.slice(0, 8) };
}

export async function listApiKeys(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.apiKey.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true, name: true, keyPrefix: true, ownerUserId: true, scopes: true,
        lastUsedAt: true, revokedAt: true, createdAt: true,
      },
    });
    res.status(200).json({ data });
  } catch (err) { next(err); }
}

export async function createApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const { name, ownerUserId, scopes } = req.body as {
      name?: string; ownerUserId?: string; scopes?: string[];
    };
    if (!name) throw badRequest("name required");
    const { raw, hash, prefix } = generateKey();
    const key = await prisma.apiKey.create({
      data: {
        name, keyHash: hash, keyPrefix: prefix,
        ownerUserId: ownerUserId ?? null,
        scopes: Array.isArray(scopes) ? scopes.join(" ") : "",
        createdBy: actorId,
      },
    });
    await adminAudit({
      actorId, action: "api_key.create", targetType: "ApiKey", targetId: key.id,
      metadata: { name, prefix, ownerUserId, scopes },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ id: key.id, prefix, rawKey: raw });
  } catch (err) { next(err); }
}

export async function rotateApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const id = req.params.keyId as string;
    const existing = await prisma.apiKey.findUnique({ where: { id } });
    if (!existing) throw notFound("Key not found");
    if (existing.revokedAt) throw badRequest("Key is revoked — create a new one instead");
    const { raw, hash, prefix } = generateKey();
    await prisma.apiKey.update({
      where: { id }, data: { keyHash: hash, keyPrefix: prefix },
    });
    await adminAudit({
      actorId, action: "api_key.rotate", targetType: "ApiKey", targetId: id,
      metadata: { oldPrefix: existing.keyPrefix, newPrefix: prefix },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ id, prefix, rawKey: raw });
  } catch (err) { next(err); }
}

export async function revokeApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const id = req.params.keyId as string;
    const existing = await prisma.apiKey.findUnique({ where: { id } });
    if (!existing) throw notFound("Key not found");
    await prisma.apiKey.update({
      where: { id },
      data:  { revokedAt: new Date(), revokedBy: actorId },
    });
    await adminAudit({
      actorId, action: "api_key.revoke", targetType: "ApiKey", targetId: id,
      metadata: { name: existing.name, prefix: existing.keyPrefix },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}
