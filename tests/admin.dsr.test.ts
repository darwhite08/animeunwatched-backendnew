import { describe, it, expect, vi, beforeEach } from "vitest";

const users = new Map<string, { id: string; email: string; username: string; passwordHash: string; role: string; displayName: string; avatarUrl: string | null; isBanned: boolean }>();
const audits: Array<{ action: string; metadata?: unknown }> = [];
const deletedUserIds: string[] = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => users.get(id) ?? null),
      delete:     vi.fn(async ({ where: { id } }: { where: { id: string } }) => { deletedUserIds.push(id); users.delete(id); return null }),
    },
    post:          { findMany: vi.fn(async () => [{ id: "p1" }]) },
    postComment:   { findMany: vi.fn(async () => []) },
    review:        { findMany: vi.fn(async () => []) },
    blog:          { findMany: vi.fn(async () => []) },
    listEntry:     { findMany: vi.fn(async () => []) },
    thread:        { findMany: vi.fn(async () => []) },
    threadReply:   { findMany: vi.fn(async () => []) },
    activity:      { findMany: vi.fn(async () => []) },
    follow:        { findMany: vi.fn(async () => []) },
    notification:  { findMany: vi.fn(async () => []) },
    conversation:  { findMany: vi.fn(async () => []) },
    deviceToken:   { findMany: vi.fn(async () => []) },
    securityEvent: { findMany: vi.fn(async () => []) },
    auditLog: {
      findFirst: vi.fn(async () => null),
      create:    vi.fn(async ({ data }: { data: { action: string; metadata: unknown } }) => { audits.push(data); return data }),
    },
  },
}));

import { exportUserData, deleteUserData } from "../app/src/modules/admin/dsr.controller";

function makeReq(params: Record<string, string>) {
  return { body: {}, params, query: {} as Record<string, string>, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return {
    locals: { user: { id: "op-1" } },
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    json:   vi.fn().mockReturnThis(),
    send:   vi.fn().mockReturnThis(),
  } as never;
}

beforeEach(() => { users.clear(); audits.length = 0; deletedUserIds.length = 0 });

describe("DSR controller", () => {
  it("exportUserData rejects unknown user", async () => {
    const next = vi.fn();
    await exportUserData(makeReq({ userId: "missing" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/not found/i);
  });

  it("exportUserData redacts passwordHash + emits audit with record counts", async () => {
    users.set("u1", { id: "u1", email: "x@y", username: "x", passwordHash: "SUPER_SECRET", role: "USER", displayName: "X", avatarUrl: null, isBanned: false });
    const res = makeRes();
    await exportUserData(makeReq({ userId: "u1" }), res, vi.fn() as never);
    const payload = JSON.parse((res.send as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(payload.user.passwordHash).toBe("[REDACTED]");
    expect(payload.exportedBy).toBe("op-1");
    expect(payload.posts).toHaveLength(1);
    const auditMeta = audits.find(a => a.action === "dsr.export")?.metadata as { recordCounts: { posts: number } };
    expect(auditMeta.recordCounts.posts).toBe(1);
  });

  it("deleteUserData hard-deletes + writes audit with summary captured BEFORE delete", async () => {
    users.set("u1", { id: "u1", email: "real@y", username: "x", passwordHash: "h", role: "USER", displayName: "X", avatarUrl: null, isBanned: false });
    await deleteUserData(makeReq({ userId: "u1" }), makeRes(), vi.fn() as never);
    expect(deletedUserIds).toEqual(["u1"]);
    const auditMeta = audits.find(a => a.action === "dsr.delete")?.metadata as { summary: { email: string } };
    expect(auditMeta.summary.email).toBe("real@y");
  });

  it("deleteUserData rejects unknown user", async () => {
    const next = vi.fn();
    await deleteUserData(makeReq({ userId: "missing" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/not found/i);
  });
});
