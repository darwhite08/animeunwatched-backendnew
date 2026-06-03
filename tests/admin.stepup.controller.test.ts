import { describe, it, expect, vi, beforeEach } from "vitest";

const users = new Map<string, { id: string; passwordHash: string }>();
let totpRow: { userId: string; secretBase32: string; enabled: boolean; backupCodes: string[] | null } | null = null;
const tokens = new Map<string, { userId: string; purpose: string; expiresAt: Date }>();
const audits: string[] = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => users.get(id) ?? null) },
    totpSecret: {
      findUnique: vi.fn(async ({ where: { userId } }: { where: { userId: string } }) => totpRow?.userId === userId ? totpRow : null),
      update:     vi.fn(async () => undefined),
    },
    stepUpToken: {
      create:     vi.fn(async ({ data }: { data: { userId: string; tokenHash: string; purpose: string; expiresAt: Date } }) => { tokens.set(data.tokenHash, data); return data }),
      findUnique: vi.fn(async ({ where: { tokenHash } }: { where: { tokenHash: string } }) => tokens.get(tokenHash) ?? null),
      update:     vi.fn(async () => undefined),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    auditLog: {
      findFirst: vi.fn(async () => null),
      create:    vi.fn(async ({ data }: { data: { action: string } }) => { audits.push(data.action); return data }),
    },
  },
}));

vi.mock("argon2", () => ({
  default: { verify: vi.fn(async (_h: string, plain: string) => plain === "correct") },
}));

import { requestStepUp } from "../app/src/modules/admin/stepup.controller";

function makeReq(body: Record<string, unknown>) {
  return { body, params: {} as Record<string, string>, query: {} as Record<string, string>, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return { locals: { user: { id: "op-1" } }, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as never;
}

beforeEach(() => {
  users.clear(); totpRow = null; tokens.clear(); audits.length = 0;
  users.set("op-1", { id: "op-1", passwordHash: "h" });
});

describe("stepup controller", () => {
  it("requires password + purpose", async () => {
    const next = vi.fn();
    await requestStepUp(makeReq({ purpose: "x" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/password required/);
  });

  it("rejects wrong password + audits stepup.failed", async () => {
    const next = vi.fn();
    await requestStepUp(makeReq({ password: "wrong", purpose: "users:role" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/Invalid password/);
    expect(audits.find(a => a === "stepup.failed")).toBeDefined();
  });

  it("issues token when no TOTP enrolled", async () => {
    const res = makeRes();
    await requestStepUp(makeReq({ password: "correct", purpose: "users:role" }), res, vi.fn() as never);
    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(call.purpose).toBe("users:role");
    expect(audits).toContain("stepup.issued");
  });

  it("requires TOTP code when enrolled, rejects bad", async () => {
    totpRow = { userId: "op-1", secretBase32: "JBSWY3DPEHPK3PXP", enabled: true, backupCodes: null };
    const next1 = vi.fn();
    await requestStepUp(makeReq({ password: "correct", purpose: "x" }), makeRes(), next1 as never);
    expect((next1.mock.calls[0][0] as Error).message).toMatch(/totp code required/);

    const next2 = vi.fn();
    await requestStepUp(makeReq({ password: "correct", totp: "000000", purpose: "x" }), makeRes(), next2 as never);
    expect((next2.mock.calls[0][0] as Error).message).toMatch(/Invalid TOTP/);
  });

  it("OAuth user with no MFA gets a clear 403 (no 500)", async () => {
    // OAuth-only users have an empty passwordHash and no TOTP. Used to crash
    // argon2.verify and bubble as "Internal server error".
    users.set("op-1", { id: "op-1", passwordHash: "" });
    const next = vi.fn();
    await requestStepUp(makeReq({ password: "anything", purpose: "users:role" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/OAuth.*MFA/);
  });

  it("OAuth user with TOTP enrolled can step up using TOTP alone", async () => {
    users.set("op-1", { id: "op-1", passwordHash: "" });
    totpRow = { userId: "op-1", secretBase32: "JBSWY3DPEHPK3PXP", enabled: true, backupCodes: null };
    // Generate the actual TOTP code for the current 30-second window so the
    // test does not depend on a fixed code.
    const { totp: makeTotp } = await import("../app/src/lib/totp");
    const code = makeTotp("JBSWY3DPEHPK3PXP");
    const res = makeRes();
    await requestStepUp(makeReq({ totp: code, purpose: "users:role" }), res, vi.fn() as never);
    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call?.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(audits).toContain("stepup.issued");
  });
});
