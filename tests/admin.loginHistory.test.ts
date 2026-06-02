import { describe, it, expect, vi, beforeEach } from "vitest";

const events: Array<{ id: string; type: string; ipAddress: string | null; userAgent: string | null; metadata: unknown; createdAt: Date }> = [];
const audits: string[] = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    securityEvent: {
      findMany: vi.fn(async () => events),
    },
    auditLog: {
      findFirst: vi.fn(async () => null),
      create:    vi.fn(async ({ data }: { data: { action: string } }) => { audits.push(data.action); return data }),
    },
  },
}));

import { getLoginHistory } from "../app/src/modules/admin/loginHistory.controller";

function makeReq(params: Record<string, string>, query: Record<string, string> = {}) {
  return { body: {}, params, query, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return { locals: { user: { id: "op-1" } }, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as never;
}

beforeEach(() => { events.length = 0; audits.length = 0 });

describe("login history", () => {
  it("audits the read (PII exposure)", async () => {
    await getLoginHistory(makeReq({ userId: "u1" }), makeRes(), vi.fn() as never);
    expect(audits).toContain("user.login_history_viewed");
  });

  it("builds IP summary with count + first/last seen", async () => {
    const d1 = new Date("2026-01-01T00:00:00Z");
    const d2 = new Date("2026-02-01T00:00:00Z");
    const d3 = new Date("2026-03-01T00:00:00Z");
    events.push({ id: "e1", type: "login_success", ipAddress: "1.1.1.1", userAgent: null, metadata: null, createdAt: d3 });
    events.push({ id: "e2", type: "login_success", ipAddress: "1.1.1.1", userAgent: null, metadata: null, createdAt: d1 });
    events.push({ id: "e3", type: "login_success", ipAddress: "2.2.2.2", userAgent: null, metadata: null, createdAt: d2 });
    const res = makeRes();
    await getLoginHistory(makeReq({ userId: "u1" }), res, vi.fn() as never);
    const ipSummary = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].ipSummary;
    const ip1 = ipSummary.find((s: { ip: string }) => s.ip === "1.1.1.1");
    expect(ip1.count).toBe(2);
    expect(new Date(ip1.firstSeen).getTime()).toBe(d1.getTime());
    expect(new Date(ip1.lastSeen).getTime()).toBe(d3.getTime());
  });

  it("returns events array intact", async () => {
    events.push({ id: "e1", type: "login_success", ipAddress: null, userAgent: null, metadata: null, createdAt: new Date() });
    const res = makeRes();
    await getLoginHistory(makeReq({ userId: "u1" }), res, vi.fn() as never);
    const data = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(data.events).toHaveLength(1);
  });
});
