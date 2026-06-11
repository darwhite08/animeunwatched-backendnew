import crypto from "node:crypto";
import { env } from "../config/env";

/**
 * Symmetric encryption for secrets stored at rest (OAuth access tokens, etc).
 * AES-256-GCM (authenticated) with a random per-value IV. Format:
 *   enc:v1:<base64(iv | ciphertext | authTag)>
 *
 * Back-compatible: open() returns legacy plaintext unchanged when the stored
 * value has no enc:v1: prefix, so existing rows keep working and get upgraded
 * to ciphertext the next time they're written.
 */

const PREFIX = "enc:v1:";

// 32-byte key derived from a high-entropy app secret. A dedicated
// TOKEN_ENCRYPTION_KEY is preferred; otherwise derive from the JWT secret.
const KEY = crypto.createHash("sha256")
  .update(process.env.TOKEN_ENCRYPTION_KEY || env.JWT_ACCESS_SECRET)
  .digest();

export function seal(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, ct, tag]).toString("base64");
}

export function open(stored: string | null | undefined): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext — back-compat
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return ""; // tampered / wrong key → fail closed (empty, never the ciphertext)
  }
}
