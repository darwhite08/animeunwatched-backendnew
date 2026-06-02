import { prisma } from "../config/prisma";

/**
 * Runtime evaluator for feature flags. Order of resolution:
 *   1. Kill switch → if killedAt is set, ALWAYS off.
 *   2. Per-user override (un-expired) → wins.
 *   3. Rollout rules (percentage by stable hash of userId, cohorts, tiers).
 *   4. enabledGlobally.
 *
 * Per-request callers should prefer `isEnabled(key, { userId })` so cohort
 * + percentage rollouts work. Anonymous callers fall back to global value.
 */

const cache = new Map<string, { value: Record<string, unknown> | null; expiresAt: number }>();
const TTL_MS = 30_000;

interface RolloutRules {
  percentage?: number;
  cohorts?:    string[];      // user.id list — small-scale targeting
  tiers?:      string[];      // entitlement source tags
}

function flagCacheKey(key: string): string { return `flag:${key}` }

async function loadFlag(key: string): Promise<{
  enabledGlobally: boolean; rolloutRules: RolloutRules | null;
  killedAt: Date | null;
} | null> {
  const cached = cache.get(flagCacheKey(key));
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value as { enabledGlobally: boolean; rolloutRules: RolloutRules | null; killedAt: Date | null } | null;
  }
  const row = await prisma.featureFlag.findUnique({
    where:  { key },
    select: { enabledGlobally: true, rolloutRules: true, killedAt: true },
  });
  const value = row
    ? { enabledGlobally: row.enabledGlobally, rolloutRules: row.rolloutRules as RolloutRules | null, killedAt: row.killedAt }
    : null;
  cache.set(flagCacheKey(key), { value: value as unknown as Record<string, unknown> | null, expiresAt: Date.now() + TTL_MS });
  return value;
}

export function invalidateFlagCache(key?: string): void {
  if (key) cache.delete(flagCacheKey(key)); else cache.clear();
}

function bucketHash(userId: string, key: string): number {
  // Stable cheap hash. Same userId+key → same bucket forever (until we change algo).
  let h = 5381;
  const s = `${userId}|${key}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 100;
}

export async function isEnabled(key: string, opts: { userId?: string } = {}): Promise<boolean> {
  const flag = await loadFlag(key);
  if (!flag) return false;
  if (flag.killedAt) return false;

  if (opts.userId) {
    const override = await prisma.featureFlagOverride.findFirst({
      where: { userId: opts.userId, flag: { key } },
      select: { enabled: true, expiresAt: true },
    });
    if (override && (!override.expiresAt || override.expiresAt > new Date())) {
      return override.enabled;
    }
    const rules = flag.rolloutRules;
    if (rules?.cohorts?.includes(opts.userId)) return true;
    if (rules?.percentage != null && bucketHash(opts.userId, key) < rules.percentage) {
      return true;
    }
  }
  return flag.enabledGlobally;
}
