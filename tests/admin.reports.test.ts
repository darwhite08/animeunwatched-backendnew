import { describe, it, expect, vi, beforeEach } from "vitest";

const schedules = new Map<string, { id: string; name: string; reportKey: string; cron: string; format: string; recipients: string[]; enabled: boolean; lastRunAt: Date | null; lastResult: string | null }>();
const audits: string[] = [];
const modItems: Array<{ status: string }> = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    reportSchedule: {
      findMany:   vi.fn(async () => Array.from(schedules.values())),
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => schedules.get(id) ?? null),
      create:     vi.fn(async ({ data }: { data: Omit<NonNullable<ReturnType<typeof schedules.get>>, "id" | "lastRunAt" | "lastResult"> }) => {
        const id = `s-${schedules.size + 1}`;
        const sched = { id, lastRunAt: null, lastResult: null, ...data };
        schedules.set(id, sched); return sched;
      }),
      update:     vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const s = schedules.get(id); if (!s) return null;
        Object.assign(s, data); return s;
      }),
      delete:     vi.fn(async ({ where: { id } }: { where: { id: string } }) => { schedules.delete(id); return null }),
    },
    moderationItem: { groupBy: vi.fn(async () => modItems.map(m => ({ status: m.status, _count: { _all: 1 } }))) },
    $queryRaw: vi.fn(async () => []),
    auditLog: {
      findFirst: vi.fn(async () => null),
      create:    vi.fn(async ({ data }: { data: { action: string } }) => { audits.push(data.action); return data }),
    },
  },
}));

import { listReportNames, getReport, exportReport, listSchedules, createSchedule, deleteSchedule, runScheduleNow } from "../app/src/modules/admin/reports.controller";

function makeReq(body: Record<string, unknown> = {}, params: Record<string, string> = {}, query: Record<string, string> = {}) {
  return { body, params, query, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
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

beforeEach(() => { schedules.clear(); audits.length = 0; modItems.length = 0 });

describe("reports controller", () => {
  it("listReportNames exposes built-in keys", async () => {
    const res = makeRes();
    listReportNames(makeReq(), res);
    const data = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data).toContain("signups");
    expect(data).toContain("active-users-7d");
    expect(data).toContain("billing-revenue");
  });

  it("getReport rejects unknown name", async () => {
    const next = vi.fn();
    await getReport(makeReq({}, { name: "bogus" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/Unknown report/);
  });

  it("getReport runs known report + audits", async () => {
    modItems.push({ status: "PENDING" });
    await getReport(makeReq({}, { name: "moderation-backlog" }), makeRes(), vi.fn() as never);
    expect(audits).toContain("report.viewed");
  });

  it("exportReport CSV writes correct headers", async () => {
    const res = makeRes();
    await exportReport(makeReq({}, { name: "moderation-backlog" }, { format: "csv" }), res, vi.fn() as never);
    expect((res.setHeader as ReturnType<typeof vi.fn>).mock.calls.find(c => c[0] === "Content-Type")?.[1]).toBe("text/csv");
    expect(audits).toContain("report.exported");
  });

  it("exportReport JSON sets application/json", async () => {
    const res = makeRes();
    await exportReport(makeReq({}, { name: "moderation-backlog" }, { format: "json" }), res, vi.fn() as never);
    expect((res.setHeader as ReturnType<typeof vi.fn>).mock.calls.find(c => c[0] === "Content-Type")?.[1]).toBe("application/json");
  });

  it("createSchedule rejects unknown reportKey", async () => {
    const next = vi.fn();
    await createSchedule(makeReq({ name: "x", reportKey: "bogus", cron: "0 0 * * *" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/Unknown reportKey/);
  });

  it("createSchedule persists + audits + sets createdBy from operator", async () => {
    await createSchedule(makeReq({ name: "Daily signups", reportKey: "signups", cron: "0 9 * * *", recipients: ["x@y"] }), makeRes(), vi.fn() as never);
    expect(schedules.size).toBe(1);
    const s = Array.from(schedules.values())[0];
    expect(s.name).toBe("Daily signups");
    expect(s.cron).toBe("0 9 * * *");
    expect(audits).toContain("report.schedule_create");
  });

  it("deleteSchedule removes row + audits", async () => {
    schedules.set("s1", { id: "s1", name: "x", reportKey: "signups", cron: "0 0 * * *", format: "csv", recipients: [], enabled: true, lastRunAt: null, lastResult: null });
    await deleteSchedule(makeReq({}, { id: "s1" }), makeRes(), vi.fn() as never);
    expect(schedules.size).toBe(0);
    expect(audits).toContain("report.schedule_delete");
  });

  it("runScheduleNow updates lastRunAt + lastResult", async () => {
    schedules.set("s1", { id: "s1", name: "x", reportKey: "moderation-backlog", cron: "0 0 * * *", format: "csv", recipients: [], enabled: true, lastRunAt: null, lastResult: null });
    await runScheduleNow(makeReq({}, { id: "s1" }), makeRes(), vi.fn() as never);
    expect(schedules.get("s1")?.lastRunAt).toBeInstanceOf(Date);
    expect(schedules.get("s1")?.lastResult).toMatch(/^ok:rowcount=/);
    expect(audits).toContain("report.schedule_run");
  });

  it("listSchedules returns shape", async () => {
    const res = makeRes();
    await listSchedules(makeReq(), res, vi.fn() as never);
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toBeDefined();
  });
});
