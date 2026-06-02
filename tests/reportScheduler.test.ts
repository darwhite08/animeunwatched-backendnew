import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist-safe: build the mocks inside the factory and expose them on the
// module exports so we can grab them after import.
vi.mock("../app/src/lib/mailer", () => {
  const sendMailMock = vi.fn(async () => ({ ok: true, dryRun: false, messageId: "m-1" }));
  return { sendMail: sendMailMock, __sendMailMock: sendMailMock };
});

vi.mock("../app/src/modules/admin/reports.controller.runner", () => ({
  runReport: vi.fn(async (key: string) => ({
    columns: ["a", "b"],
    rows:    key === "empty" ? [] : [{ a: 1, b: 2 }, { a: 3, b: 4 }],
  })),
}));

import { runOneSchedule } from "../app/src/jobs/reportScheduler.job";
import * as mailerModule from "../app/src/lib/mailer";
const sendMailMock = (mailerModule as unknown as { __sendMailMock: ReturnType<typeof vi.fn> }).__sendMailMock;

beforeEach(() => { sendMailMock.mockClear() });

describe("reportScheduler.runOneSchedule", () => {
  it("does nothing when recipients[] is empty", async () => {
    const r = await runOneSchedule("signups", "csv", [], "Daily signups");
    expect(r.rows).toBe(2);
    expect(r.delivered).toBe(0);
    expect(r.dryRun).toBe(0);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("sends once per recipient with CSV attachment by default", async () => {
    const r = await runOneSchedule("signups", "csv", ["a@x", "b@x"], "Daily");
    expect(sendMailMock).toHaveBeenCalledTimes(2);
    const call = sendMailMock.mock.calls[0][0] as { attachments: Array<{ filename: string; contentType: string }>; tag: string };
    expect(call.attachments[0].contentType).toBe("text/csv");
    expect(call.attachments[0].filename).toMatch(/^signups-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(call.tag).toBe("report");
    expect(r.delivered).toBe(2);
    expect(r.failed).toBe(0);
  });

  it("uses JSON format + extension when format=json", async () => {
    await runOneSchedule("signups", "json", ["a@x"], "Daily");
    const call = sendMailMock.mock.calls[0][0] as { attachments: Array<{ filename: string; contentType: string; content: string }> };
    expect(call.attachments[0].contentType).toBe("application/json");
    expect(call.attachments[0].filename).toMatch(/\.json$/);
    expect(JSON.parse(call.attachments[0].content).columns).toEqual(["a", "b"]);
  });

  it("counts dryRun vs delivered separately", async () => {
    sendMailMock.mockResolvedValueOnce({ ok: true, dryRun: true, messageId: undefined } as Awaited<ReturnType<typeof sendMailMock>>);
    sendMailMock.mockResolvedValueOnce({ ok: true, dryRun: false, messageId: "m-2" } as Awaited<ReturnType<typeof sendMailMock>>);
    const r = await runOneSchedule("signups", "csv", ["a@x", "b@x"], "Daily");
    expect(r.dryRun).toBe(1);
    expect(r.delivered).toBe(1);
  });

  it("captures failures with error strings", async () => {
    sendMailMock.mockResolvedValueOnce({ ok: false, dryRun: false, error: "smtp timeout" } as Awaited<ReturnType<typeof sendMailMock>>);
    sendMailMock.mockResolvedValueOnce({ ok: true, dryRun: false, messageId: "m-3" } as Awaited<ReturnType<typeof sendMailMock>>);
    const r = await runOneSchedule("signups", "csv", ["a@x", "b@x"], "Daily");
    expect(r.failed).toBe(1);
    expect(r.delivered).toBe(1);
    expect(r.errors).toEqual(["smtp timeout"]);
  });

  it("returns rows=0 for an empty report but still has empty CSV", async () => {
    const r = await runOneSchedule("empty", "csv", ["a@x"], "Empty");
    expect(r.rows).toBe(0);
    expect(r.delivered).toBe(1);
  });

  it("subject includes schedule name + row count", async () => {
    await runOneSchedule("signups", "csv", ["a@x"], "Weekly digest");
    const call = sendMailMock.mock.calls[0][0] as { subject: string };
    expect(call.subject).toContain("Weekly digest");
    expect(call.subject).toContain("2 rows");
  });
});
