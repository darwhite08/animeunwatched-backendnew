import { describe, it, expect, vi, beforeEach } from "vitest";

const flags = new Map<string, { id: string; key: string; type: string; enabledGlobally: boolean; rolloutRules: unknown; isKillSwitch: boolean; killedAt: Date | null; killedBy: string | null; killedReason: string | null; description: string | null }>();
const overrides = new Map<string, { id: string; flagId: string; userId: string; enabled: boolean }>();
const audits: string[] = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    featureFlag: {
      findMany: vi.fn(async () => Array.from(flags.values()).map(f => ({ ...f, _count: { overrides: Array.from(overrides.values()).filter(o => o.flagId === f.id).length } }))),
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => flags.get(id) ?? null),
      create:     vi.fn(async ({ data }: { data: { key: string; description: string | null; type: string; enabledGlobally: boolean; isKillSwitch: boolean; rolloutRules: unknown } }) => {
        const f = { id: `f-${flags.size + 1}`, killedAt: null, killedBy: null, killedReason: null, ...data };
        flags.set(f.id, f); return f;
      }),
      update:     vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const f = flags.get(id); if (!f) return null;
        Object.assign(f, data); return f;
      }),
      delete:     vi.fn(async ({ where: { id } }: { where: { id: string } }) => { flags.delete(id); return null }),
    },
    featureFlagOverride: {
      upsert: vi.fn(async ({ where: { flagId_userId }, create }: { where: { flagId_userId: { flagId: string; userId: string } }; create: { flagId: string; userId: string; enabled: boolean } }) => {
        const k = `${flagId_userId.flagId}|${flagId_userId.userId}`;
        const o = { id: k, ...create };
        overrides.set(k, o); return o;
      }),
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const o = overrides.get(id);
        if (!o) return null;
        return { ...o, flag: flags.get(o.flagId) };
      }),
      findFirst: vi.fn(async () => null),
      findMany:  vi.fn(async ({ where: { flagId } }: { where: { flagId: string } }) => Array.from(overrides.values()).filter(o => o.flagId === flagId)),
      delete:    vi.fn(async ({ where: { id } }: { where: { id: string } }) => { overrides.delete(id); return null }),
    },
    auditLog: {
      findFirst: vi.fn(async () => null),
      create:    vi.fn(async ({ data }: { data: { action: string } }) => { audits.push(data.action); return data }),
    },
  },
}));

import { listFlags, createFlag, updateFlag, killFlag, reviveFlag, deleteFlag, createOverride, listOverrides, deleteOverride, evaluateFlag } from "../app/src/modules/admin/flags.controller";

function makeReq(body: Record<string, unknown> = {}, params: Record<string, string> = {}, query: Record<string, string> = {}) {
  return { body, params, query, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return { locals: { user: { id: "op-1" } }, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as never;
}

beforeEach(() => { flags.clear(); overrides.clear(); audits.length = 0; });

describe("flags controller", () => {
  it("createFlag validates key format", async () => {
    const next = vi.fn();
    await createFlag(makeReq({ key: "InvalidKey!" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/lowercase/);
  });

  it("createFlag persists + audits", async () => {
    await createFlag(makeReq({ key: "creator.beta", type: "experiment", enabledGlobally: true }), makeRes(), vi.fn() as never);
    expect(flags.size).toBe(1);
    expect(audits).toContain("flag.create");
  });

  it("killFlag sets killedAt + killedBy + audits", async () => {
    flags.set("f1", { id: "f1", key: "x", type: "release", enabledGlobally: true, rolloutRules: null, isKillSwitch: true, killedAt: null, killedBy: null, killedReason: null, description: null });
    await killFlag(makeReq({ reason: "incident" }, { flagId: "f1" }), makeRes(), vi.fn() as never);
    const f = flags.get("f1");
    expect(f?.killedAt).toBeInstanceOf(Date);
    expect(f?.killedBy).toBe("op-1");
    expect(f?.killedReason).toBe("incident");
    expect(audits).toContain("flag.kill");
  });

  it("reviveFlag clears killed state", async () => {
    flags.set("f1", { id: "f1", key: "x", type: "release", enabledGlobally: false, rolloutRules: null, isKillSwitch: true, killedAt: new Date(), killedBy: "op", killedReason: "r", description: null });
    await reviveFlag(makeReq({}, { flagId: "f1" }), makeRes(), vi.fn() as never);
    expect(flags.get("f1")?.killedAt).toBeNull();
    expect(audits).toContain("flag.revive");
  });

  it("updateFlag captures before/after in audit metadata", async () => {
    flags.set("f1", { id: "f1", key: "x", type: "release", enabledGlobally: false, rolloutRules: null, isKillSwitch: false, killedAt: null, killedBy: null, killedReason: null, description: null });
    await updateFlag(makeReq({ enabledGlobally: true }, { flagId: "f1" }), makeRes(), vi.fn() as never);
    expect(flags.get("f1")?.enabledGlobally).toBe(true);
    expect(audits).toContain("flag.update");
  });

  it("createOverride upserts per-user override", async () => {
    flags.set("f1", { id: "f1", key: "x", type: "release", enabledGlobally: false, rolloutRules: null, isKillSwitch: false, killedAt: null, killedBy: null, killedReason: null, description: null });
    await createOverride(makeReq({ userId: "u1", enabled: true, reason: "test" }, { flagId: "f1" }), makeRes(), vi.fn() as never);
    expect(overrides.size).toBe(1);
    expect(audits).toContain("flag.override");
  });

  it("createOverride rejects missing enabled flag", async () => {
    flags.set("f1", { id: "f1", key: "x", type: "release", enabledGlobally: false, rolloutRules: null, isKillSwitch: false, killedAt: null, killedBy: null, killedReason: null, description: null });
    const next = vi.fn();
    await createOverride(makeReq({ userId: "u1" }, { flagId: "f1" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/enabled required/);
  });

  it("deleteFlag removes from store + audits", async () => {
    flags.set("f1", { id: "f1", key: "x", type: "release", enabledGlobally: false, rolloutRules: null, isKillSwitch: false, killedAt: null, killedBy: null, killedReason: null, description: null });
    await deleteFlag(makeReq({}, { flagId: "f1" }), makeRes(), vi.fn() as never);
    expect(flags.size).toBe(0);
    expect(audits).toContain("flag.delete");
  });

  it("listOverrides + listFlags shape", async () => {
    flags.set("f1", { id: "f1", key: "x", type: "release", enabledGlobally: false, rolloutRules: null, isKillSwitch: false, killedAt: null, killedBy: null, killedReason: null, description: null });
    overrides.set("k", { id: "k", flagId: "f1", userId: "u1", enabled: true });
    const res1 = makeRes(); await listOverrides(makeReq({}, { flagId: "f1" }), res1, vi.fn() as never);
    expect((res1.json as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toHaveLength(1);
    const res2 = makeRes(); await listFlags(makeReq(), res2, vi.fn() as never);
    expect((res2.json as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toHaveLength(1);
  });

  it("evaluateFlag returns {key,userId,enabled}", async () => {
    const res = makeRes();
    await evaluateFlag(makeReq({}, { key: "doesnotexist" }, { userId: "u1" }), res, vi.fn() as never);
    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.key).toBe("doesnotexist");
    expect(call.enabled).toBe(false);
  });
});
