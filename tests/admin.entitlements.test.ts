import { describe, it, expect, vi, beforeEach } from "vitest";

const ents = new Map<string, { id: string; userId: string; feature: string; limit: number | null; source: string; expiresAt: Date | null; reason: string | null; grantedBy: string | null }>();
const audits: string[] = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    entitlement: {
      findMany: vi.fn(async () => Array.from(ents.values())),
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => ents.get(id) ?? null),
      count:    vi.fn(async () => ents.size),
      upsert:   vi.fn(async ({ where: { userId_feature }, create }: { where: { userId_feature: { userId: string; feature: string } }; create: { userId: string; feature: string; limit: number | null; source: string; expiresAt: Date | null; reason: string | null; grantedBy: string | null } }) => {
        const k = `${userId_feature.userId}|${userId_feature.feature}`;
        const e = { id: k, ...create };
        ents.set(k, e); return e;
      }),
      delete:   vi.fn(async ({ where: { id } }: { where: { id: string } }) => { ents.delete(id); return null }),
    },
    auditLog: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: { action: string } }) => { audits.push(data.action); return data }),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

import { listEntitlements, grantEntitlement, revokeEntitlement } from "../app/src/modules/admin/entitlements.controller";

function makeReq(body: Record<string, unknown> = {}, params: Record<string, string> = {}, query: Record<string, string> = {}) {
  return { body, params, query, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return { locals: { user: { id: "op-1" } }, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as never;
}

beforeEach(() => { ents.clear(); audits.length = 0 });

describe("entitlements", () => {
  it("grantEntitlement requires userId + feature", async () => {
    const next = vi.fn();
    await grantEntitlement(makeReq({ userId: "u1" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/required/);
  });

  it("grantEntitlement upserts row + audits with grantedBy", async () => {
    await grantEntitlement(makeReq({ userId: "u1", feature: "creator_studio", limit: 50, source: "manual" }), makeRes(), vi.fn() as never);
    expect(ents.size).toBe(1);
    const ent = Array.from(ents.values())[0];
    expect(ent.userId).toBe("u1");
    expect(ent.feature).toBe("creator_studio");
    expect(ent.limit).toBe(50);
    expect(ent.grantedBy).toBe("op-1");
    expect(audits).toContain("entitlement.grant");
  });

  it("grantEntitlement re-upserts when called again for same user+feature", async () => {
    await grantEntitlement(makeReq({ userId: "u1", feature: "x", limit: 10 }), makeRes(), vi.fn() as never);
    await grantEntitlement(makeReq({ userId: "u1", feature: "x", limit: 20 }), makeRes(), vi.fn() as never);
    expect(ents.size).toBe(1);
  });

  it("revokeEntitlement deletes + audits", async () => {
    ents.set("k", { id: "k", userId: "u1", feature: "x", limit: null, source: "manual", expiresAt: null, reason: null, grantedBy: "op" });
    await revokeEntitlement(makeReq({}, { id: "k" }), makeRes(), vi.fn() as never);
    expect(ents.size).toBe(0);
    expect(audits).toContain("entitlement.revoke");
  });

  it("revokeEntitlement returns notFound when missing", async () => {
    const next = vi.fn();
    await revokeEntitlement(makeReq({}, { id: "missing" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/not found/i);
  });

  it("listEntitlements paginates", async () => {
    ents.set("a", { id: "a", userId: "u1", feature: "x", limit: null, source: "manual", expiresAt: null, reason: null, grantedBy: null });
    const res = makeRes();
    await listEntitlements(makeReq({}, {}, { page: "1", limit: "10" }), res, vi.fn() as never);
    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.page).toBe(1);
    expect(call.limit).toBe(10);
    expect(call.data).toHaveLength(1);
  });
});
