import { prisma } from "../config/prisma";

/**
 * Auth hardening hooks. Used by the existing auth.service.login handler
 * (no behavioral change in production until the guards are wired in).
 *
 *   - Account lockout: after 5 failed attempts in 15 min, refuse for 15 min
 *   - IP block: brute-force IPs land in IpBlock and are refused outright
 *   - MFA enforcement: when security.mfaRequired = true, users without
 *     enrolled TOTP cannot complete sign-in
 *   - IP allowlist: when security.ipAllowList is non-empty, only listed
 *     IPs may authenticate to admin-scoped endpoints
 */

const LOCKOUT_WINDOW_MS  = 15 * 60_000
const LOCKOUT_THRESHOLD  = 5
const BRUTE_IP_THRESHOLD = 30      // 30 fails in 15 min from one IP = brute force

const POLICY_KEYS = {
  mfaRequired:  "security.mfaRequired",
  ipAllowList:  "security.ipAllowList",
} as const

async function getPolicy<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.adminSetting.findUnique({ where: { key } })
  return (row?.value as T | undefined) ?? fallback
}

/** Throw-friendly check before processing a login. Returns null if OK,
 *  or a reason string if the request should be refused. */
export async function preLoginChecks(opts: { email: string; ip: string | null }): Promise<string | null> {
  // 1. IP block
  if (opts.ip) {
    const blocked = await prisma.ipBlock.findUnique({ where: { ip: opts.ip } })
    if (blocked && blocked.expiresAt > new Date()) {
      return `IP temporarily blocked (${blocked.reason})`
    }
  }

  // 2. IP allowlist for admin surface
  const allow = await getPolicy<string[]>(POLICY_KEYS.ipAllowList, [])
  if (allow.length > 0 && opts.ip && !allow.includes(opts.ip)) {
    // Only enforced when an allowlist is configured — empty = no restriction
    return "IP not on allow-list"
  }

  // 3. Account lockout
  const since = new Date(Date.now() - LOCKOUT_WINDOW_MS)
  const user  = await prisma.user.findUnique({ where: { email: opts.email }, select: { id: true } })
  if (user) {
    const fails = await prisma.securityEvent.count({
      where: { userId: user.id, type: "login_failed", createdAt: { gte: since } },
    })
    if (fails >= LOCKOUT_THRESHOLD) {
      return `Account locked: ${fails} failed attempts in the last 15 min`
    }
  }

  return null
}

/** Called AFTER a verified password match but BEFORE issuing tokens.
 *  Returns "mfa_required" if the user has no TOTP and policy says required. */
export async function postPasswordChecks(userId: string): Promise<"ok" | "mfa_required"> {
  const mfaRequired = await getPolicy<boolean>(POLICY_KEYS.mfaRequired, false)
  if (!mfaRequired) return "ok"
  const totp = await prisma.totpSecret.findUnique({ where: { userId }, select: { enabled: true } })
  return totp?.enabled ? "ok" : "mfa_required"
}

/** Called after a recorded login_failed. Auto-blocks the source IP when
 *  it crosses the brute-force threshold. */
export async function maybeBlockBruteIp(ip: string | null): Promise<void> {
  if (!ip) return
  const since = new Date(Date.now() - LOCKOUT_WINDOW_MS)
  const fails = await prisma.securityEvent.count({
    where: { ipAddress: ip, type: "login_failed", createdAt: { gte: since } },
  })
  if (fails < BRUTE_IP_THRESHOLD) return
  await prisma.ipBlock.upsert({
    where:  { ip },
    update: { reason: "bruteforce", expiresAt: new Date(Date.now() + 60 * 60_000) },
    create: { ip, reason: "bruteforce", expiresAt: new Date(Date.now() + 60 * 60_000) },
  })
}

/** Helper for /admin/inspect/ip pages. */
export async function isIpBlocked(ip: string): Promise<{ blocked: boolean; reason?: string; expiresAt?: Date }> {
  const row = await prisma.ipBlock.findUnique({ where: { ip } })
  if (!row || row.expiresAt < new Date()) return { blocked: false }
  return { blocked: true, reason: row.reason, expiresAt: row.expiresAt }
}
