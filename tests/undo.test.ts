import { describe, it, expect, vi, beforeEach } from "vitest";

const auditRows = new Map<string, {
  id: string; action: string; targetId: string | null; targetType: string | null;
  actorId: string | null; createdAt: Date; metadata: unknown;
}>();
const users = new Map<string, { id: string; isBanned: boolean; bannedReason: string | null; displayName: string; bio: string | null; reputation: number; role: string; isShadowBanned: boolean }>();
const newAudits: string[] = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    auditLog: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => auditRows.get(id) ?? null),
      findMany:   vi.fn(async () => Array.from(auditRows.values())),
      findFirst:  vi.fn(async () => null),
      create:     vi.fn(async ({ data }: { data: { action: string } }) => { newAudits.push(data.action); return data }),
    },
    user: {
      update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const u = users.get(id); if (!u) return null;
        Object.assign(u, data); return u;
      }),
    },
    adminRole:     { findUnique: vi.fn(async () => null) },
    userAdminRole: { deleteMany: vi.fn(async () => ({ count: 0 })), upsert: vi.fn(async () => undefined) },
    featureFlag:   { update: vi.fn(async () => undefined) },
  },
}));

import { undoAction } from "../app/src/modules/admin/undo.controller";

function makeReq(params: Record<string, string>) {
  return { params, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return {
    locals: { user: { id: "op-1" } },
    status: vi.fn().mockReturnThis(),
    json:   vi.fn().mockReturnThis(),
  } as never;
}

beforeEach(() => {
  auditRows.clear(); users.clear(); newAudits.length = 0;
});

describe("undo system", () => {
  it("undoing user.ban marks user unbanned", async () => {
    users.set("u1", { id: "u1", isBanned: true, bannedReason: "spam", displayName: "x", bio: null, reputation: 0, role: "USER", isShadowBanned: false });
    auditRows.set("a1", { id: "a1", action: "user.ban", targetId: "u1", targetType: "User", actorId: "op", createdAt: new Date(), metadata: { reason: "spam" } });
    await undoAction(makeReq({ auditId: "a1" }), makeRes(), vi.fn() as never);
    expect(users.get("u1")?.isBanned).toBe(false);
    expect(users.get("u1")?.bannedReason).toBeNull();
    expect(newAudits).toContain("undo.user.ban");
  });

  it("undoing user.unban re-bans with prior reason", async () => {
    users.set("u1", { id: "u1", isBanned: false, bannedReason: null, displayName: "x", bio: null, reputation: 0, role: "USER", isShadowBanned: false });
    auditRows.set("a1", { id: "a1", action: "user.unban", targetId: "u1", targetType: "User", actorId: "op", createdAt: new Date(), metadata: { reason: "appealed" } });
    await undoAction(makeReq({ auditId: "a1" }), makeRes(), vi.fn() as never);
    expect(users.get("u1")?.isBanned).toBe(true);
    expect(users.get("u1")?.bannedReason).toBe("appealed");
  });

  it("undoing user.update restores before state", async () => {
    users.set("u1", { id: "u1", isBanned: false, bannedReason: null, displayName: "new", bio: "updated", reputation: 99, role: "USER", isShadowBanned: false });
    auditRows.set("a1", { id: "a1", action: "user.update", targetId: "u1", targetType: "User", actorId: "op", createdAt: new Date(),
      metadata: { before: { displayName: "old", bio: "original", reputation: 10 } } });
    await undoAction(makeReq({ auditId: "a1" }), makeRes(), vi.fn() as never);
    expect(users.get("u1")?.displayName).toBe("old");
    expect(users.get("u1")?.bio).toBe("original");
    expect(users.get("u1")?.reputation).toBe(10);
  });

  it("rejects undo of non-undoable action", async () => {
    auditRows.set("a1", { id: "a1", action: "settings.delete", targetId: "k", targetType: null, actorId: "op", createdAt: new Date(), metadata: {} });
    const next = vi.fn();
    await undoAction(makeReq({ auditId: "a1" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/not undoable/);
  });

  it("rejects undo outside 24h window", async () => {
    auditRows.set("a1", { id: "a1", action: "user.ban", targetId: "u1", targetType: "User", actorId: "op", createdAt: new Date(Date.now() - 48 * 3600_000), metadata: {} });
    const next = vi.fn();
    await undoAction(makeReq({ auditId: "a1" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/window/);
  });
});
