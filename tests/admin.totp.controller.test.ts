import { describe, it, expect, vi, beforeEach } from "vitest";

const users = new Map<string, { id: string; email: string; passwordHash: string }>();
let totpRow: { userId: string; secretBase32: string; enabled: boolean; backupCodes: string[] | null } | null = null;
const audits: string[] = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => users.get(id) ?? null),
    },
    totpSecret: {
      findUnique: vi.fn(async ({ where: { userId } }: { where: { userId: string } }) => totpRow?.userId === userId ? totpRow : null),
      upsert:     vi.fn(async ({ where: { userId }, create }: { where: { userId: string }; create: { userId: string; secretBase32: string } }) => {
        totpRow = { userId, secretBase32: create.secretBase32, enabled: false, backupCodes: null };
        return totpRow;
      }),
      update:     vi.fn(async ({ where: { userId }, data }: { where: { userId: string }; data: Record<string, unknown> }) => {
        if (!totpRow || totpRow.userId !== userId) return null;
        Object.assign(totpRow, data);
        return totpRow;
      }),
      deleteMany: vi.fn(async ({ where: { userId } }: { where: { userId: string } }) => {
        const had = totpRow?.userId === userId;
        if (had) totpRow = null;
        return { count: had ? 1 : 0 };
      }),
    },
    securityEvent: { create: vi.fn(async () => undefined) },
  },
}));

// Need to mock argon2 verify
vi.mock("argon2", () => ({
  default: { verify: vi.fn(async (_h: string, plain: string) => plain === "correct-password") },
}));

import { setupTotp, verifyTotpEnroll, disableTotp, getTotpStatus } from "../app/src/modules/auth/totp.controller";
import { totp } from "../app/src/lib/totp";

function makeReq(body: Record<string, unknown> = {}) {
  return { body, params: {} as Record<string, string>, query: {} as Record<string, string>, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return { locals: { user: { id: "u1" } }, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as never;
}

beforeEach(() => {
  users.clear(); totpRow = null; audits.length = 0;
  users.set("u1", { id: "u1", email: "x@y", passwordHash: "argonhash" });
});

describe("totp.controller", () => {
  it("setupTotp creates a disabled secret + returns otpauth URL", async () => {
    const res = makeRes();
    await setupTotp(makeReq(), res, vi.fn() as never);
    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.secret).toMatch(/^[A-Z2-7]+$/);
    expect(call.otpauth).toMatch(/^otpauth:\/\/totp\//);
    expect(totpRow?.enabled).toBe(false);
  });

  it("setupTotp blocks re-enroll if already enabled", async () => {
    totpRow = { userId: "u1", secretBase32: "ABCD", enabled: true, backupCodes: null };
    const next = vi.fn();
    await setupTotp(makeReq(), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/already enabled/);
  });

  it("verifyTotpEnroll rejects bad code", async () => {
    totpRow = { userId: "u1", secretBase32: "JBSWY3DPEHPK3PXP", enabled: false, backupCodes: null };
    const next = vi.fn();
    await verifyTotpEnroll(makeReq({ code: "000000" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/invalid code/);
  });

  it("verifyTotpEnroll accepts current code, enables + returns backup codes", async () => {
    totpRow = { userId: "u1", secretBase32: "JBSWY3DPEHPK3PXP", enabled: false, backupCodes: null };
    const code = totp(totpRow.secretBase32);
    const res = makeRes();
    await verifyTotpEnroll(makeReq({ code }), res, vi.fn() as never);
    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.enabled).toBe(true);
    expect(call.backupCodes).toHaveLength(8);
    expect(totpRow?.enabled).toBe(true);
  });

  it("disableTotp rejects wrong password", async () => {
    const next = vi.fn();
    await disableTotp(makeReq({ password: "wrong" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/Invalid password/);
  });

  it("disableTotp wipes secret on correct password", async () => {
    totpRow = { userId: "u1", secretBase32: "ABCD", enabled: true, backupCodes: null };
    await disableTotp(makeReq({ password: "correct-password" }), makeRes(), vi.fn() as never);
    expect(totpRow).toBeNull();
  });

  it("getTotpStatus returns enabled bool", async () => {
    totpRow = { userId: "u1", secretBase32: "X", enabled: true, backupCodes: null };
    const res = makeRes();
    await getTotpStatus(makeReq(), res, vi.fn() as never);
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({ enabled: true });
  });
});
