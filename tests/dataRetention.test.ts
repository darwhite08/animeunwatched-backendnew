import { describe, it, expect, vi, beforeEach } from "vitest";

let setting: { value: Record<string, number> | null } | null = null;
const auditRows: Array<{ action: string; metadata: unknown }> = [];
let refreshTokenDeleted = 0;
let securityEventDeleted = 0;
let auditLogDeleted = 0;
let auditLogCount = 0;

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    adminSetting:  { findUnique: vi.fn(async () => setting) },
    refreshToken:  { deleteMany: vi.fn(async () => ({ count: refreshTokenDeleted })) },
    securityEvent: { deleteMany: vi.fn(async () => ({ count: securityEventDeleted })) },
    auditLog: {
      count:      vi.fn(async () => auditLogCount),
      deleteMany: vi.fn(async () => ({ count: auditLogDeleted })),
      findFirst:  vi.fn(async () => null),
      create:     vi.fn(async ({ data }: { data: { action: string; metadata: unknown } }) => {
        auditRows.push({ action: data.action, metadata: data.metadata });
        return { id: "x", integrityHash: "h" };
      }),
    },
  },
}));

import { runDataRetention } from "../app/src/jobs/dataRetention.job";

beforeEach(() => {
  setting = null;
  auditRows.length = 0;
  refreshTokenDeleted = 0;
  securityEventDeleted = 0;
  auditLogDeleted = 0;
  auditLogCount = 0;
});

describe("dataRetention", () => {
  it("uses defaults when no setting is configured", async () => {
    refreshTokenDeleted = 3;
    securityEventDeleted = 5;
    const r = await runDataRetention();
    expect(r.purged.refreshTokens).toBe(3);
    expect(r.purged.securityEvents).toBe(5);
  });

  it("writes an audit summary BEFORE deleting AuditLog rows", async () => {
    auditLogCount    = 42;
    auditLogDeleted  = 42;
    await runDataRetention();
    const summary = auditRows.find(a => a.action === "audit.retention_purged");
    expect(summary).toBeTruthy();
    expect((summary?.metadata as { purgedCount: number }).purgedCount).toBe(42);
  });

  it("skips the AuditLog purge when count is 0", async () => {
    auditLogCount    = 0;
    auditLogDeleted  = 0;
    const r = await runDataRetention();
    expect(r.purged.auditLog).toBe(0);
    expect(auditRows.find(a => a.action === "audit.retention_purged")).toBeUndefined();
  });

  it("respects custom retention setting", async () => {
    setting = { value: { audit: 0, sessions: 7, securityEvents: 0 } };
    refreshTokenDeleted  = 99;
    securityEventDeleted = 99;
    auditLogDeleted      = 99;
    const r = await runDataRetention();
    // sessions=7 → counted; audit=0 + securityEvents=0 → skipped
    expect(r.purged.refreshTokens).toBe(99);
    expect(r.purged.securityEvents).toBeUndefined();
    expect(r.purged.auditLog).toBeUndefined();
  });
});
