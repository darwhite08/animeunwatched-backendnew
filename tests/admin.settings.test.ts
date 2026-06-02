import { describe, it, expect, vi, beforeEach } from "vitest";

const settings = new Map<string, { key: string; value: unknown; description: string | null; updatedBy: string | null; updatedAt: Date }>();
const audits: string[] = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    adminSetting: {
      findMany:   vi.fn(async () => Array.from(settings.values())),
      findUnique: vi.fn(async ({ where: { key } }: { where: { key: string } }) => settings.get(key) ?? null),
      upsert:     vi.fn(async ({ where: { key }, create }: { where: { key: string }; create: { key: string; value: unknown; description?: string; updatedBy?: string } }) => {
        const row = { key, value: create.value, description: create.description ?? null, updatedBy: create.updatedBy ?? null, updatedAt: new Date() };
        settings.set(key, row); return row;
      }),
      delete:     vi.fn(async ({ where: { key } }: { where: { key: string } }) => { settings.delete(key); return null }),
    },
    auditLog: {
      findFirst: vi.fn(async () => null),
      create:    vi.fn(async ({ data }: { data: { action: string } }) => { audits.push(data.action); return data }),
    },
  },
}));

import { listSettings, getSetting, upsertSetting, deleteSetting } from "../app/src/modules/admin/settings.controller";

function makeReq(body: Record<string, unknown> = {}, params: Record<string, string> = {}) {
  return { body, params, query: {} as Record<string, string>, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return { locals: { user: { id: "op-1" } }, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as never;
}

beforeEach(() => { settings.clear(); audits.length = 0 });

describe("settings controller", () => {
  it("upsertSetting rejects missing value", async () => {
    const next = vi.fn();
    await upsertSetting(makeReq({}, { key: "x" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/value required/);
  });

  it("upsertSetting create writes 'setting.create' audit", async () => {
    await upsertSetting(makeReq({ value: { color: "#fff" }, description: "brand" }, { key: "brand" }), makeRes(), vi.fn() as never);
    expect(settings.get("brand")?.value).toEqual({ color: "#fff" });
    expect(audits).toContain("setting.create");
  });

  it("upsertSetting update writes 'setting.update' audit", async () => {
    settings.set("brand", { key: "brand", value: "old", description: null, updatedBy: null, updatedAt: new Date() });
    await upsertSetting(makeReq({ value: "new" }, { key: "brand" }), makeRes(), vi.fn() as never);
    expect(settings.get("brand")?.value).toBe("new");
    expect(audits).toContain("setting.update");
  });

  it("deleteSetting returns notFound for missing key", async () => {
    const next = vi.fn();
    await deleteSetting(makeReq({}, { key: "missing" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/not found/i);
  });

  it("deleteSetting removes + audits", async () => {
    settings.set("x", { key: "x", value: 1, description: null, updatedBy: null, updatedAt: new Date() });
    await deleteSetting(makeReq({}, { key: "x" }), makeRes(), vi.fn() as never);
    expect(settings.size).toBe(0);
    expect(audits).toContain("setting.delete");
  });

  it("listSettings + getSetting shape", async () => {
    settings.set("x", { key: "x", value: 1, description: null, updatedBy: null, updatedAt: new Date() });
    const res1 = makeRes(); await listSettings(makeReq(), res1, vi.fn() as never);
    expect((res1.json as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toHaveLength(1);
    const res2 = makeRes(); await getSetting(makeReq({}, { key: "x" }), res2, vi.fn() as never);
    expect((res2.json as ReturnType<typeof vi.fn>).mock.calls[0][0].key).toBe("x");
  });

  it("getSetting returns notFound for missing key", async () => {
    const next = vi.fn();
    await getSetting(makeReq({}, { key: "missing" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/not found/i);
  });
});
