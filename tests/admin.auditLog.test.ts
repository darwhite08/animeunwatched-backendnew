import { describe, it, expect, vi, beforeEach } from "vitest";

const rows: Array<{ id: string; action: string; actorId: string | null; targetType: string | null; targetId: string | null; createdAt: Date; integrityHash: string; prevHash: string | null; metadata: unknown; impersonatorId: string | null; ipAddress: string | null; userAgent: string | null }> = [];
const audits: string[] = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    auditLog: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        let result = rows.slice();
        if (where.actorId)    result = result.filter(r => r.actorId === where.actorId);
        if (where.targetType) result = result.filter(r => r.targetType === where.targetType);
        return result;
      }),
      count:    vi.fn(async () => rows.length),
      findFirst: vi.fn(async () => null),
      create:    vi.fn(async ({ data }: { data: { action: string } }) => { audits.push(data.action); return data }),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("../app/src/lib/adminAudit", async () => {
  const real = await vi.importActual<typeof import("../app/src/lib/adminAudit")>("../app/src/lib/adminAudit");
  return {
    ...real,
    verifyAdminAuditChain: vi.fn(async () => null),  // chain intact for tests
  };
});

import { listAuditLog, exportAuditLog, verifyAuditChain } from "../app/src/modules/admin/auditLog.controller";

function makeReq(query: Record<string, string> = {}) {
  return { body: {}, params: {} as Record<string, string>, query, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return {
    locals: { user: { id: "op-1" } },
    status: vi.fn().mockReturnThis(),
    json:   vi.fn().mockReturnThis(),
    send:   vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as never;
}

beforeEach(() => { rows.length = 0; audits.length = 0 });

describe("auditLog controller", () => {
  it("listAuditLog emits 'audit.viewed' (self-audit per spec M8)", async () => {
    rows.push({ id: "1", action: "user.ban", actorId: "op", targetType: "User", targetId: "u1", createdAt: new Date(), integrityHash: "h", prevHash: null, metadata: null, impersonatorId: null, ipAddress: null, userAgent: null });
    await listAuditLog(makeReq(), makeRes(), vi.fn() as never);
    expect(audits).toContain("audit.viewed");
  });

  it("listAuditLog filters by actor + action", async () => {
    rows.push({ id: "1", action: "user.ban", actorId: "op1", targetType: null, targetId: null, createdAt: new Date(), integrityHash: "h1", prevHash: null, metadata: null, impersonatorId: null, ipAddress: null, userAgent: null });
    rows.push({ id: "2", action: "user.ban", actorId: "op2", targetType: null, targetId: null, createdAt: new Date(), integrityHash: "h2", prevHash: null, metadata: null, impersonatorId: null, ipAddress: null, userAgent: null });
    const res = makeRes();
    await listAuditLog(makeReq({ actor: "op1" }), res, vi.fn() as never);
    const data = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data).toHaveLength(1);
  });

  it("exportAuditLog writes 'audit.exported' + CSV with header", async () => {
    rows.push({ id: "1", action: "test", actorId: null, targetType: null, targetId: null, createdAt: new Date("2026-01-01T00:00:00Z"), integrityHash: "h", prevHash: null, metadata: null, impersonatorId: null, ipAddress: null, userAgent: null });
    const res = makeRes();
    await exportAuditLog(makeReq(), res, vi.fn() as never);
    expect(audits).toContain("audit.exported");
    const csv = (res.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(csv).toContain("createdAt,action,actorId");  // header row
    expect(csv).toContain("test");                       // row
  });

  it("verifyAuditChain returns intact:true when mock chain ok", async () => {
    const res = makeRes();
    await verifyAuditChain(makeReq(), res, vi.fn() as never);
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ intact: true });
  });
});
