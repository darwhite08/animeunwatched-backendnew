import { describe, it, expect, vi, beforeEach } from "vitest";

const settings = new Map<string, { value: unknown }>();
const events: Array<{ id: string; type: string; userId: string | null; ipAddress: string | null; userAgent: string | null; metadata: unknown; createdAt: Date }> = [];
const audits: string[] = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    adminSetting: {
      findMany:   vi.fn(async () => Array.from(settings.entries()).map(([k, v]) => ({ key: k, ...v }))),
      findUnique: vi.fn(async ({ where: { key } }: { where: { key: string } }) => settings.has(key) ? { key, ...settings.get(key) } : null),
      upsert:     vi.fn(async ({ where: { key }, create }: { where: { key: string }; create: { key: string; value: unknown } }) => {
        settings.set(key, { value: create.value });
        return { key, value: create.value };
      }),
    },
    securityEvent: {
      findMany: vi.fn(async ({ where, take }: { where?: { type?: string }; take: number }) => {
        let result = events.slice();
        if (where?.type) result = result.filter(e => e.type === where.type);
        return result.slice(0, take).map(e => ({ ...e, user: null }));
      }),
      count:    vi.fn(async () => events.length),
    },
    auditLog: {
      findFirst: vi.fn(async () => null),
      create:    vi.fn(async ({ data }: { data: { action: string } }) => { audits.push(data.action); return data }),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

import { getPolicies, setPolicy, listSecurityEvents } from "../app/src/modules/admin/security.controller";

function makeReq(body: Record<string, unknown> = {}, query: Record<string, string> = {}) {
  return { body, params: {} as Record<string, string>, query, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return { locals: { user: { id: "op-1" } }, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as never;
}

beforeEach(() => { settings.clear(); events.length = 0; audits.length = 0 });

describe("security controller", () => {
  it("getPolicies returns defaults when no settings exist", async () => {
    const res = makeRes();
    await getPolicies(makeReq(), res, vi.fn() as never);
    const data = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data["security.mfaRequired"]).toBe(false);
    expect(data["security.passwordMinLen"]).toBe(8);
    expect(data["security.sessionTtlMin"]).toBe(1440);
    expect(data["security.ipAllowList"]).toEqual([]);
    expect(data["security.dataRetentionDays"]).toMatchObject({ audit: 365 });
  });

  it("getPolicies overlays stored values onto defaults", async () => {
    settings.set("security.mfaRequired", { value: true });
    settings.set("security.passwordMinLen", { value: 16 });
    const res = makeRes();
    await getPolicies(makeReq(), res, vi.fn() as never);
    const data = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data["security.mfaRequired"]).toBe(true);
    expect(data["security.passwordMinLen"]).toBe(16);
    expect(data["security.sessionTtlMin"]).toBe(1440); // default still
  });

  it("setPolicy rejects unknown key", async () => {
    const next = vi.fn();
    await setPolicy(makeReq({ key: "bogus", value: 1 }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/unknown policy key/);
  });

  it("setPolicy rejects missing value", async () => {
    const next = vi.fn();
    await setPolicy(makeReq({ key: "security.mfaRequired" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/value required/);
  });

  it("setPolicy upserts + audits with before/after", async () => {
    settings.set("security.passwordMinLen", { value: 8 });
    await setPolicy(makeReq({ key: "security.passwordMinLen", value: 12 }), makeRes(), vi.fn() as never);
    expect(settings.get("security.passwordMinLen")?.value).toBe(12);
    expect(audits).toContain("security.policy_update");
  });

  it("listSecurityEvents filters by type", async () => {
    events.push({ id: "e1", type: "login_success", userId: "u1", ipAddress: "1.1.1.1", userAgent: null, metadata: null, createdAt: new Date() });
    events.push({ id: "e2", type: "login_failed",  userId: "u1", ipAddress: "1.1.1.1", userAgent: null, metadata: null, createdAt: new Date() });
    const res = makeRes();
    await listSecurityEvents(makeReq({}, { type: "login_failed" }), res, vi.fn() as never);
    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.every((e: { type: string }) => e.type === "login_failed")).toBe(true);
  });

  it("listSecurityEvents writes audit-on-read", async () => {
    await listSecurityEvents(makeReq(), makeRes(), vi.fn() as never);
    expect(audits).toContain("security.events_viewed");
  });
});
