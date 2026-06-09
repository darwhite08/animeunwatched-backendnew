import { prisma } from "../../config/prisma";
import { isEnabled } from "../../lib/featureFlags";

// Client-facing feature flags (kill switches). Each maps to a user-facing feature
// the app/web can hide or disable. DEFAULT = ON: a feature is only off if an admin
// has explicitly created its flag and disabled/killed it — so a missing flag never
// breaks the app. Toggle these live from the admin dashboard (/admin/flags).
export const CLIENT_FLAG_KEYS = [
  "calls",            // 1:1 audio/video calls
  "video-calls",      // video specifically (audio can stay on)
  "dm",               // direct messages
  "groups",           // group chat
  "club-chat",        // realtime club chat room
  "clubs",            // clubs feature as a whole
  "club-events",      // club events / watch parties
  "club-challenges",  // watch challenges
  "club-leaderboard", // club XP leaderboard
  "e2ee",             // end-to-end encrypted DM
  "encrypted-media",  // encrypted images/voice
  "voice-messages",   // voice notes
  "shots",            // short videos
  "peeak",            // 24h stories
  "recommended-feed",
  "trending-feed",
  "following-feed",
  "post-comments",
  "post-likes",
] as const

export type ClientFlagKey = (typeof CLIENT_FLAG_KEYS)[number]

let seeded = false

/** Idempotently ensure each client flag exists as a kill-switch row (default ON),
 *  so it shows up in the admin dashboard ready to toggle. Runs once per process. */
export async function ensureClientFlagsSeeded(): Promise<void> {
  if (seeded) return
  seeded = true
  try {
    const existing = new Set(
      (await prisma.featureFlag.findMany({ where: { key: { in: [...CLIENT_FLAG_KEYS] } }, select: { key: true } })).map((f) => f.key),
    )
    const missing = CLIENT_FLAG_KEYS.filter((k) => !existing.has(k))
    if (missing.length) {
      await prisma.featureFlag.createMany({
        data: missing.map((key) => ({ key, description: `Client feature: ${key}`, type: "ops", enabledGlobally: true, isKillSwitch: true })),
        skipDuplicates: true,
      })
    }
  } catch { seeded = false /* retry next call */ }
}

/** Evaluate all client flags for the caller. Missing/unconfigured keys → ON. */
export async function getClientFlags(userId?: string): Promise<Record<string, boolean>> {
  await ensureClientFlagsSeeded()
  const rows = await prisma.featureFlag.findMany({
    where: { key: { in: [...CLIENT_FLAG_KEYS] } },
    select: { key: true },
  })
  const configured = new Set(rows.map((r) => r.key))
  const out: Record<string, boolean> = {}
  for (const key of CLIENT_FLAG_KEYS) {
    out[key] = configured.has(key) ? await isEnabled(key, { userId }) : true
  }
  return out
}

// ── Admin: list + toggle client flags (simple requireAdmin path) ──────────────

export async function listClientFlagsAdmin() {
  await ensureClientFlagsSeeded()
  const rows = await prisma.featureFlag.findMany({
    where: { key: { in: [...CLIENT_FLAG_KEYS] } },
    select: { key: true, description: true, enabledGlobally: true, killedAt: true },
  })
  const byKey = new Map(rows.map((r) => [r.key, r]))
  return CLIENT_FLAG_KEYS.map((key) => {
    const r = byKey.get(key)
    return { key, description: r?.description ?? null, enabled: r ? (r.enabledGlobally && !r.killedAt) : true }
  })
}

export async function setClientFlag(key: string, enabled: boolean) {
  if (!(CLIENT_FLAG_KEYS as readonly string[]).includes(key)) {
    const e = new Error("Unknown flag") as Error & { status?: number }
    e.status = 400
    throw e
  }
  await prisma.featureFlag.upsert({
    where: { key },
    update: { enabledGlobally: enabled, killedAt: enabled ? null : new Date() },
    create: { key, description: `Client feature: ${key}`, type: "ops", isKillSwitch: true, enabledGlobally: enabled, ...(enabled ? {} : { killedAt: new Date() }) },
  })
  return { key, enabled }
}
