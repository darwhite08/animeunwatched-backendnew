import crypto from "crypto";
import { prisma } from "../config/prisma";
import { forbidden } from "./errors";

// Invite-only signup gate. The master on/off switch lives in AdminSetting under
// `invite_only`; admin-generated SignupInvite codes are what let people through
// while it's on. See docs or admin/signupAccess.controller.ts.

const SETTING_KEY = "invite_only";

export async function getInviteOnly(): Promise<boolean> {
  const row = await prisma.adminSetting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) return false; // default OFF — a missing setting never gates signups
  const v = row.value as unknown;
  if (typeof v === "boolean") return v;
  if (v && typeof v === "object" && "enabled" in v) return !!(v as { enabled?: boolean }).enabled;
  return false;
}

export async function setInviteOnly(enabled: boolean, actorId?: string) {
  await prisma.adminSetting.upsert({
    where: { key: SETTING_KEY },
    update: { value: { enabled }, updatedBy: actorId },
    create: { key: SETTING_KEY, value: { enabled }, description: "Gate public signup behind invite codes", updatedBy: actorId },
  });
  return { inviteOnly: enabled };
}

/**
 * Enforce the gate during signup. No-op when the gate is off. When it's on:
 * require a valid, non-revoked, non-expired, non-exhausted code and atomically
 * consume one use (the DB-level conditional update prevents over-use races).
 * Throws `forbidden` otherwise.
 */
export async function enforceSignupGate(code: string | undefined): Promise<void> {
  if (!(await getInviteOnly())) return;
  const c = (code ?? "").trim();
  if (!c) throw forbidden("Kaiveron is invite-only right now. A valid invite code is required to sign up.");

  const { count } = await prisma.signupInvite.updateMany({
    where: {
      code: c,
      revokedAt: null,
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        // maxUses 0 = unlimited; otherwise only while uses < maxUses
        { OR: [{ maxUses: 0 }, { uses: { lt: prisma.signupInvite.fields.maxUses } }] },
      ],
    },
    data: { uses: { increment: 1 } },
  });
  if (count === 0) throw forbidden("That invite code is invalid, expired, or fully used.");
}

// ── Admin management ─────────────────────────────────────────────────────────

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I/L
function genCode(len = 8): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export async function createSignupInvite(opts: { label?: string; maxUses?: number; expiresInDays?: number; actorId?: string }) {
  // Retry on the rare unique-collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.signupInvite.create({
        data: {
          code: genCode(8),
          label: opts.label?.slice(0, 80) || null,
          maxUses: Math.max(0, Math.floor(opts.maxUses ?? 0)),
          expiresAt: opts.expiresInDays && opts.expiresInDays > 0 ? new Date(Date.now() + opts.expiresInDays * 86_400_000) : null,
          createdBy: opts.actorId ?? null,
        },
      });
    } catch (err: unknown) {
      if (typeof err === "object" && err && (err as { code?: string }).code === "P2002") continue;
      throw err;
    }
  }
  throw new Error("Could not generate a unique invite code");
}

export async function listSignupInvites() {
  return prisma.signupInvite.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
}

export async function revokeSignupInvite(id: string) {
  return prisma.signupInvite.update({ where: { id }, data: { revokedAt: new Date() } });
}
