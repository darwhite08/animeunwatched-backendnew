import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/lib/jobRegistry", () => ({
  listJobs: vi.fn(() => [{ name: "test", description: "x", intervalMs: 1000, lastRunAt: null, lastDurationMs: null, lastStatus: "idle", lastError: null, runCount: 0 }]),
  runJob:   vi.fn(async (name: string) => {
    if (name === "missing") throw new Error("unknown job: missing");
  }),
}));

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    auditLog: {
      findFirst: vi.fn(async () => null),
      create:    vi.fn(async () => undefined),
    },
  },
}));

import { getJobs, retryJob } from "../app/src/modules/admin/jobs.controller";

function makeReq(params: Record<string, string> = {}) {
  return { body: {}, params, query: {} as Record<string, string>, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return { locals: { user: { id: "op-1" } }, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as never;
}

describe("jobs controller", () => {
  it("getJobs returns registry list", () => {
    const res = makeRes();
    getJobs(makeReq(), res, vi.fn() as never);
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toHaveLength(1);
  });

  it("retryJob requires name", async () => {
    const next = vi.fn();
    await retryJob(makeReq({}), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/required/);
  });

  it("retryJob calls runJob + returns ok", async () => {
    const res = makeRes();
    await retryJob(makeReq({ name: "ok" }), res, vi.fn() as never);
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ ok: true });
  });

  it("retryJob propagates unknown-job error via next()", async () => {
    const next = vi.fn();
    await retryJob(makeReq({ name: "missing" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/unknown job/);
  });
});
