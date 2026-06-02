import { describe, it, expect, vi, beforeEach } from "vitest";

interface FlagRow {
  enabledGlobally: boolean;
  rolloutRules:    { percentage?: number; cohorts?: string[]; tiers?: string[] } | null;
  killedAt:        Date | null;
}
interface OverrideRow { enabled: boolean; expiresAt: Date | null }

const flags     = new Map<string, FlagRow>();
const overrides = new Map<string, OverrideRow>();  // key = `${flagKey}|${userId}`

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    featureFlag: {
      findUnique: vi.fn(async ({ where: { key } }: { where: { key: string } }) =>
        flags.has(key) ? flags.get(key) : null),
    },
    featureFlagOverride: {
      findFirst: vi.fn(async ({ where }: { where: { userId: string; flag: { key: string } } }) => {
        const k = `${where.flag.key}|${where.userId}`;
        return overrides.get(k) ?? null;
      }),
    },
  },
}));

import { isEnabled, invalidateFlagCache } from "../app/src/lib/featureFlags";

beforeEach(() => {
  flags.clear();
  overrides.clear();
  invalidateFlagCache();
});

describe("featureFlags", () => {
  it("missing flag → disabled", async () => {
    expect(await isEnabled("does.not.exist")).toBe(false);
  });

  it("kill switch wins over everything", async () => {
    flags.set("k", { enabledGlobally: true, rolloutRules: null, killedAt: new Date() });
    overrides.set("k|u1", { enabled: true, expiresAt: null });
    expect(await isEnabled("k", { userId: "u1" })).toBe(false);
  });

  it("override wins over rollout", async () => {
    flags.set("k", { enabledGlobally: false, rolloutRules: { percentage: 0 }, killedAt: null });
    overrides.set("k|u1", { enabled: true, expiresAt: null });
    expect(await isEnabled("k", { userId: "u1" })).toBe(true);
  });

  it("expired override is ignored", async () => {
    flags.set("k", { enabledGlobally: false, rolloutRules: null, killedAt: null });
    overrides.set("k|u1", { enabled: true, expiresAt: new Date(Date.now() - 1000) });
    expect(await isEnabled("k", { userId: "u1" })).toBe(false);
  });

  it("cohort match enables for listed users", async () => {
    flags.set("k", { enabledGlobally: false, rolloutRules: { cohorts: ["u1","u2"] }, killedAt: null });
    expect(await isEnabled("k", { userId: "u1" })).toBe(true);
    expect(await isEnabled("k", { userId: "u3" })).toBe(false);
  });

  it("percentage rollout is stable per user (same userId → same bucket)", async () => {
    flags.set("k", { enabledGlobally: false, rolloutRules: { percentage: 100 }, killedAt: null });
    expect(await isEnabled("k", { userId: "u1" })).toBe(true);
    invalidateFlagCache();
    expect(await isEnabled("k", { userId: "u1" })).toBe(true);
  });

  it("percentage=0 disables for everyone", async () => {
    flags.set("k", { enabledGlobally: false, rolloutRules: { percentage: 0 }, killedAt: null });
    for (const u of ["u1","u2","u3","u4"]) {
      expect(await isEnabled("k", { userId: u })).toBe(false);
    }
  });

  it("enabledGlobally is the fallback when no rules + no override", async () => {
    flags.set("k", { enabledGlobally: true, rolloutRules: null, killedAt: null });
    expect(await isEnabled("k", { userId: "u1" })).toBe(true);
    expect(await isEnabled("k")).toBe(true);
  });
});
