import crypto from "node:crypto";
import { prisma } from "../config/prisma";

/**
 * Append-only ADMIN audit log. Every privileged admin mutation calls this.
 * Distinct from lib/audit.ts (SecurityEvent) which captures end-user auth
 * events — AuditLog captures who-did-what to whom on the admin surface.
 *
 * Hash chain: integrityHash = SHA-256(prevHash || JSON.stringify(entry)).
 * Tampering with a row breaks every hash after it.
 *
 * NEVER mutate AuditLog rows from anywhere except this file.
 */
export interface AdminAuditInput {
  actorId?:        string | null;
  impersonatorId?: string | null;
  action:          string;          // "user.ban", "role.grant", "flag.kill", "audit.viewed"
  targetType?:     string | null;
  targetId?:       string | null;
  metadata?:       Record<string, unknown> | null;  // { before, after, reason }
  ipAddress?:      string | null;
  userAgent?:      string | null;
}

let inFlight: Promise<unknown> = Promise.resolve();

export async function adminAudit(input: AdminAuditInput): Promise<void> {
  // Serialize writes so the hash chain stays linear even under concurrency.
  inFlight = inFlight.catch(() => undefined).then(() => writeEntry(input));
  await inFlight;
}

async function writeEntry(input: AdminAuditInput): Promise<void> {
  const prev = await prisma.auditLog.findFirst({
    orderBy: { createdAt: "desc" },
    select:  { integrityHash: true },
  });
  const prevHash = prev?.integrityHash ?? null;

  const payload = JSON.stringify({
    prevHash,
    actorId:        input.actorId        ?? null,
    impersonatorId: input.impersonatorId ?? null,
    action:         input.action,
    targetType:     input.targetType     ?? null,
    targetId:       input.targetId       ?? null,
    metadata:       input.metadata       ?? null,
    ipAddress:      input.ipAddress      ?? null,
    userAgent:      input.userAgent      ?? null,
  });
  const integrityHash = crypto.createHash("sha256").update(payload).digest("hex");

  await prisma.auditLog.create({
    data: {
      actorId:        input.actorId        ?? null,
      impersonatorId: input.impersonatorId ?? null,
      action:         input.action,
      targetType:     input.targetType     ?? null,
      targetId:       input.targetId       ?? null,
      metadata:       (input.metadata ?? null) as never,
      ipAddress:      input.ipAddress      ?? null,
      userAgent:      input.userAgent      ?? null,
      prevHash,
      integrityHash,
    },
  });
}

/**
 * Verify the entire chain. Returns first row whose stored hash disagrees
 * with the recomputed hash, or null if intact.
 */
export async function verifyAdminAuditChain(): Promise<{ brokenAt: string } | null> {
  const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } });
  let prevHash: string | null = null;
  for (const r of rows) {
    const recomputed: string = crypto.createHash("sha256").update(JSON.stringify({
      prevHash,
      actorId:        r.actorId,
      impersonatorId: r.impersonatorId,
      action:         r.action,
      targetType:     r.targetType,
      targetId:       r.targetId,
      metadata:       r.metadata,
      ipAddress:      r.ipAddress,
      userAgent:      r.userAgent,
    })).digest("hex");
    if (recomputed !== r.integrityHash) return { brokenAt: r.id };
    prevHash = r.integrityHash;
  }
  return null;
}

export function ipFromReq(req: { headers: Record<string, unknown>; ip?: string }): string | null {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0].trim();
  return req.ip ?? null;
}

export function uaFromReq(req: { headers: Record<string, unknown> }): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 500) : null;
}
