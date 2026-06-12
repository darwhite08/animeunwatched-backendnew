/**
 * Email-verification (signup OTP) unit tests. Prisma + email are mocked.
 * Covers: correct code verifies + clears the row, wrong code increments attempts,
 * expiry, attempt cap, idempotent re-verify, and resend cooldown.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), update: vi.fn() },
  emailVerification: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn(), upsert: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("../app/src/config/prisma", () => ({ prisma: prismaMock }));
vi.mock("../app/src/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  welcomeEmail: vi.fn().mockReturnValue({ to: "x", subject: "y", html: "z" }),
  verificationEmail: vi.fn().mockReturnValue({ to: "x", subject: "y", html: "z" }),
  isEmailConfigured: vi.fn().mockReturnValue(true),
}));

import { verifyEmail, resendVerification } from "../app/src/modules/auth/auth.service";

const hash = (code: string) => crypto.createHash("sha256").update(code).digest("hex");
const USER = { id: "u1", email: "a@b.com", username: "neo", displayName: "Neo", emailVerifiedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  // $transaction returns the resolved results of the operations passed in.
  prismaMock.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
  prismaMock.user.update.mockResolvedValue({ ...USER, emailVerifiedAt: new Date() });
  prismaMock.emailVerification.delete.mockResolvedValue({});
});

describe("verifyEmail", () => {
  it("verifies with the correct code and clears the pending row", async () => {
    prismaMock.user.findUnique.mockResolvedValue(USER);
    prismaMock.emailVerification.findUnique.mockResolvedValue({
      userId: "u1", codeHash: hash("123456"), expiresAt: new Date(Date.now() + 60_000), attempts: 0,
    });

    const res = await verifyEmail("u1", "123456");
    expect(res.user?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(prismaMock.$transaction).toHaveBeenCalledOnce();
  });

  it("rejects a wrong code and increments attempts", async () => {
    prismaMock.user.findUnique.mockResolvedValue(USER);
    prismaMock.emailVerification.findUnique.mockResolvedValue({
      userId: "u1", codeHash: hash("123456"), expiresAt: new Date(Date.now() + 60_000), attempts: 0,
    });

    await expect(verifyEmail("u1", "000000")).rejects.toMatchObject({ code: "INVALID_CODE" });
    expect(prismaMock.emailVerification.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { attempts: { increment: 1 } } }),
    );
  });

  it("rejects an expired code", async () => {
    prismaMock.user.findUnique.mockResolvedValue(USER);
    prismaMock.emailVerification.findUnique.mockResolvedValue({
      userId: "u1", codeHash: hash("123456"), expiresAt: new Date(Date.now() - 1), attempts: 0,
    });
    await expect(verifyEmail("u1", "123456")).rejects.toMatchObject({ code: "CODE_EXPIRED" });
  });

  it("rejects once the attempt cap is hit", async () => {
    prismaMock.user.findUnique.mockResolvedValue(USER);
    prismaMock.emailVerification.findUnique.mockResolvedValue({
      userId: "u1", codeHash: hash("123456"), expiresAt: new Date(Date.now() + 60_000), attempts: 6,
    });
    await expect(verifyEmail("u1", "123456")).rejects.toMatchObject({ code: "TOO_MANY_ATTEMPTS" });
  });

  it("is idempotent if the user is already verified", async () => {
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ ...USER, emailVerifiedAt: new Date() })  // guard read
      .mockResolvedValueOnce({ ...USER, emailVerifiedAt: new Date() }); // re-read for response
    const res = await verifyEmail("u1", "999999");
    expect(res.user).toBeTruthy();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

describe("resendVerification", () => {
  it("blocks a resend inside the cooldown window", async () => {
    prismaMock.user.findUnique.mockResolvedValue(USER);
    prismaMock.emailVerification.findUnique.mockResolvedValue({
      userId: "u1", codeHash: hash("123456"), expiresAt: new Date(Date.now() + 60_000), attempts: 0,
      sentAt: new Date(), // just sent
    });
    await expect(resendVerification("u1")).rejects.toMatchObject({ code: "RESEND_COOLDOWN" });
  });

  it("issues a fresh code after the cooldown", async () => {
    prismaMock.user.findUnique.mockResolvedValue(USER);
    prismaMock.emailVerification.findUnique.mockResolvedValue({
      userId: "u1", codeHash: hash("123456"), expiresAt: new Date(Date.now() + 60_000), attempts: 0,
      sentAt: new Date(Date.now() - 120_000), // 2 min ago
    });
    prismaMock.emailVerification.upsert.mockResolvedValue({});
    const res = await resendVerification("u1");
    expect(res).toEqual({ sent: true });
    expect(prismaMock.emailVerification.upsert).toHaveBeenCalledOnce();
  });

  it("no-ops for an already-verified user", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ ...USER, emailVerifiedAt: new Date() });
    const res = await resendVerification("u1");
    expect(res).toEqual({ alreadyVerified: true });
  });
});
