import crypto from "node:crypto";
import { prisma } from "../config/prisma";

/**
 * Short-lived "step-up" credential. Issued after the user re-authenticates
 * (password + TOTP code) and required for the highest-risk admin actions.
 *
 * Lifetime: 5 minutes. Single-use. Hashed in storage so DB leak ≠ token theft.
 * Scope: tied to a "purpose" string like "users:role" — token issued for one
 * purpose cannot be replayed against another.
 */
const TTL_MS = 5 * 60 * 1000;

export async function issueStepUpToken(userId: string, purpose: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  await prisma.stepUpToken.create({
    data: {
      userId,
      tokenHash,
      purpose,
      expiresAt: new Date(Date.now() + TTL_MS),
    },
  });
  return raw;
}

/**
 * One-shot consume. Returns true ONLY if the token exists, matches user+purpose,
 * is not expired, and has not been consumed. Marks consumed on success so it
 * can't be replayed.
 */
export async function consumeStepUpToken(
  userId: string,
  rawToken: string,
  purpose: string,
): Promise<boolean> {
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const row = await prisma.stepUpToken.findUnique({ where: { tokenHash } });
  if (!row) return false;
  if (row.userId !== userId) return false;
  if (row.purpose !== purpose) return false;
  if (row.consumedAt) return false;
  if (row.expiresAt < new Date()) return false;
  await prisma.stepUpToken.update({
    where: { tokenHash },
    data:  { consumedAt: new Date() },
  });
  return true;
}

/** Best-effort cleanup; safe to call from a cron or on app boot. */
export async function purgeExpiredStepUpTokens(): Promise<number> {
  const { count } = await prisma.stepUpToken.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - 86_400_000) } },
  });
  return count;
}
