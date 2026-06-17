import { createHmac, timingSafeEqual } from "crypto"
import { env } from "../config/env"

/**
 * Stateless, signed unsubscribe tokens for List-Unsubscribe / RFC 8058 one-click
 * unsubscribe. HMAC-SHA256 over `${userId}.${scope}` — no DB row, no expiry
 * (unsubscribe links must keep working forever). The token identifies the
 * recipient + which email category to turn off.
 */
export type UnsubScope = "msg" // email-on-new-message; add more as we add categories

const SCOPES: UnsubScope[] = ["msg"]

function sign(payload: string): string {
  return createHmac("sha256", env.JWT_ACCESS_SECRET).update(payload).digest("base64url")
}

export function makeUnsubToken(userId: string, scope: UnsubScope): string {
  const payload = `${userId}.${scope}`
  return Buffer.from(`${payload}.${sign(payload)}`).toString("base64url")
}

export function verifyUnsubToken(token: string): { userId: string; scope: UnsubScope } | null {
  try {
    const parts = Buffer.from(token, "base64url").toString("utf8").split(".")
    if (parts.length !== 3) return null
    const [userId, scope, sig] = parts
    if (!userId || !SCOPES.includes(scope as UnsubScope)) return null
    const expected = sign(`${userId}.${scope}`)
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    return { userId, scope: scope as UnsubScope }
  } catch {
    return null
  }
}

/** Full one-click unsubscribe URL for the given user + scope. */
export function unsubscribeUrl(userId: string, scope: UnsubScope): string {
  return `${env.API_URL}/api/v1/unsubscribe?token=${makeUnsubToken(userId, scope)}`
}
