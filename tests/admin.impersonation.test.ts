import { describe, it, expect, vi, beforeEach } from "vitest";

const sessions = new Map<string, { id: string; impersonatorId: string; targetUserId: string; reason: string; expiresAt: Date; endedAt: Date | null; endedReason: string | null }>();
const flags    = new Map<string, { enabledGlobally: boolean; killedAt: Date | null }>();
const users    = new Map<string, { id: string; role: string; isBanned: boolean; username: string; email: string }>();
const audits: string[] = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => users.get(id) ?? null),
    },
    impersonationSession: {
      create: vi.fn(async ({ data }: { data: Omit<NonNullable<ReturnType<typeof sessions.get>>, "id" | "endedAt" | "endedReason"> }) => {
        const id = `s-${sessions.size + 1}`;
        const s = { id, endedAt: null, endedReason: null, ...data };
        sessions.set(id, s); return s;
      }),
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => sessions.get(id) ?? null),
      update:     vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const s = sessions.get(id); if (!s) return null;
        Object.assign(s, data); return s;
      }),
      findMany:   vi.fn(async ({ where }: { where: { endedAt: null; expiresAt: { gt: Date } } }) => {
        const now = where.expiresAt.gt;
        return Array.from(sessions.values()).filter(s => s.endedAt === null && s.expiresAt > now);
      }),
    },
    featureFlag: {
      findUnique: vi.fn(async ({ where: { key } }: { where: { key: string } }) => flags.get(key) ?? null),
    },
    featureFlagOverride: { findFirst: vi.fn(async () => null) },
    auditLog: {
      findFirst: vi.fn(async () => null),
      create:    vi.fn(async ({ data }: { data: { action: string } }) => { audits.push(data.action); return data }),
    },
  },
}));

vi.mock("../app/src/modules/auth/auth.service", () => ({
  signImpersonationToken: vi.fn(() => "fake.jwt.token"),
}));

import { startImpersonation, stopImpersonation, listActive } from "../app/src/modules/admin/impersonation.controller";
import { invalidateFlagCache } from "../app/src/lib/featureFlags";

function makeReq(body: Record<string, unknown> = {}, locals: Record<string, unknown> = {}) {
  return { body, params: {} as Record<string, string>, query: {} as Record<string, string>, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes(impersonationId?: string) {
  return {
    locals: { user: { id: "op-1" }, impersonationId },
    status: vi.fn().mockReturnThis(),
    json:   vi.fn().mockReturnThis(),
  } as never;
}

beforeEach(() => {
  sessions.clear(); flags.clear(); users.clear(); audits.length = 0;
  invalidateFlagCache();
  flags.set("impersonation.enabled", { enabledGlobally: true, killedAt: null });
});

describe("impersonation", () => {
  it("rejects missing reason", async () => {
    users.set("u1", { id: "u1", role: "USER", isBanned: false, username: "u", email: "u@x" });
    const next = vi.fn();
    await startImpersonation(makeReq({ targetUserId: "u1" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/reason/);
  });

  it("rejects impersonating an admin", async () => {
    users.set("u1", { id: "u1", role: "ADMIN", isBanned: false, username: "u", email: "u@x" });
    const next = vi.fn();
    await startImpersonation(makeReq({ targetUserId: "u1", reason: "debugging issue X" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/another admin/);
  });

  it("rejects when kill switch is on (flag killed)", async () => {
    users.set("u1", { id: "u1", role: "USER", isBanned: false, username: "u", email: "u@x" });
    flags.set("impersonation.enabled", { enabledGlobally: true, killedAt: new Date() });
    const next = vi.fn();
    await startImpersonation(makeReq({ targetUserId: "u1", reason: "debug" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/kill switch/);
  });

  it("rejects self-impersonation", async () => {
    users.set("op-1", { id: "op-1", role: "USER", isBanned: false, username: "x", email: "x@y" });
    const next = vi.fn();
    await startImpersonation(makeReq({ targetUserId: "op-1", reason: "test reason" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/yourself/);
  });

  it("creates session + audits start", async () => {
    users.set("u1", { id: "u1", role: "USER", isBanned: false, username: "u", email: "u@x" });
    const res = makeRes();
    await startImpersonation(makeReq({ targetUserId: "u1", reason: "debug session" }), res, vi.fn() as never);
    expect(sessions.size).toBe(1);
    expect(audits).toContain("impersonation.start");
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].token).toBe("fake.jwt.token");
  });

  it("stop marks session ended + audits", async () => {
    sessions.set("s1", { id: "s1", impersonatorId: "op-1", targetUserId: "u1", reason: "x", expiresAt: new Date(Date.now() + 60000), endedAt: null, endedReason: null });
    await stopImpersonation({ body: {}, params: {} as Record<string, string>, query: {}, headers: {}, ip: "1.1.1.1" } as never, makeRes("s1"), vi.fn() as never);
    expect(sessions.get("s1")?.endedAt).toBeInstanceOf(Date);
    expect(sessions.get("s1")?.endedReason).toBe("operator_stop");
    expect(audits).toContain("impersonation.stop");
  });

  it("stop rejects when no active impersonation in context", async () => {
    const next = vi.fn();
    await stopImpersonation({ body: {}, params: {} as Record<string, string>, query: {}, headers: {}, ip: "1.1.1.1" } as never, makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/No active/);
  });

  it("listActive returns un-ended un-expired sessions", async () => {
    sessions.set("s1", { id: "s1", impersonatorId: "op-1", targetUserId: "u1", reason: "x", expiresAt: new Date(Date.now() + 60000), endedAt: null, endedReason: null });
    sessions.set("s2", { id: "s2", impersonatorId: "op-1", targetUserId: "u2", reason: "y", expiresAt: new Date(Date.now() + 60000), endedAt: new Date(), endedReason: "operator_stop" });
    const res = makeRes();
    await listActive(makeReq(), res, vi.fn() as never);
    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data).toHaveLength(1);
    expect(call.data[0].id).toBe("s1");
  });
});
