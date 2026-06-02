import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

const rows: Array<{ id: string; integrityHash: string; prevHash: string | null;
  actorId: string | null; impersonatorId: string | null;
  action: string; targetType: string | null; targetId: string | null;
  metadata: unknown; ipAddress: string | null; userAgent: string | null;
  createdAt: Date;
}> = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    auditLog: {
      findFirst: vi.fn(async () => rows.length ? rows[rows.length - 1] : null),
      findMany:  vi.fn(async () => [...rows]),
      create:    vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `id-${rows.length}`, createdAt: new Date(), ...data } as typeof rows[number];
        rows.push(row);
        return row;
      }),
    },
  },
}));

import { adminAudit, verifyAdminAuditChain } from "../app/src/lib/adminAudit";

beforeEach(() => { rows.length = 0; });

describe("adminAudit chain", () => {
  it("first entry has no prevHash and a hex integrityHash", async () => {
    await adminAudit({ actorId: "u1", action: "user.ban", targetType: "User", targetId: "u9" });
    expect(rows).toHaveLength(1);
    expect(rows[0].prevHash).toBeNull();
    expect(rows[0].integrityHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("subsequent entries chain prevHash from the previous integrityHash", async () => {
    await adminAudit({ actorId: "u1", action: "a", targetId: "x" });
    await adminAudit({ actorId: "u1", action: "b", targetId: "y" });
    await adminAudit({ actorId: "u1", action: "c", targetId: "z" });
    expect(rows).toHaveLength(3);
    expect(rows[1].prevHash).toBe(rows[0].integrityHash);
    expect(rows[2].prevHash).toBe(rows[1].integrityHash);
  });

  it("verifyAdminAuditChain returns null when the chain is intact", async () => {
    await adminAudit({ actorId: "u1", action: "a" });
    await adminAudit({ actorId: "u1", action: "b" });
    expect(await verifyAdminAuditChain()).toBeNull();
  });

  it("verifyAdminAuditChain detects tampering of a metadata field", async () => {
    await adminAudit({ actorId: "u1", action: "a" });
    await adminAudit({ actorId: "u1", action: "b", metadata: { x: 1 } });
    rows[1].metadata = { x: 2 };  // tamper
    const result = await verifyAdminAuditChain();
    expect(result?.brokenAt).toBe(rows[1].id);
  });

  it("each integrityHash equals SHA-256(payload)", async () => {
    await adminAudit({ actorId: "u1", action: "test", targetId: "tgt" });
    const r = rows[0];
    const payload = JSON.stringify({
      prevHash:       r.prevHash,
      actorId:        r.actorId,
      impersonatorId: r.impersonatorId,
      action:         r.action,
      targetType:     r.targetType,
      targetId:       r.targetId,
      metadata:       r.metadata,
      ipAddress:      r.ipAddress,
      userAgent:      r.userAgent,
    });
    const expected = crypto.createHash("sha256").update(payload).digest("hex");
    expect(r.integrityHash).toBe(expected);
  });
});
