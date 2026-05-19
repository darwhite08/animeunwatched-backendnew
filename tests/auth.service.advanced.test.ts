/**
 * Advanced auth service tests — OAuth, refresh rotation, edge cases.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpError } from "../app/src/lib/errors";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    refreshToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    userOAuthProvider: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    userPublicKey: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("../app/src/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  welcomeEmail: vi.fn().mockReturnValue({ to: "x", subject: "y", html: "z" }),
}));

describe("refresh service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws UNAUTHORIZED when refresh token not in DB", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { signRefreshToken, refresh } = await import("../app/src/modules/auth/auth.service");

    const token = signRefreshToken("user-1");

    (prisma.refreshToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(refresh(token)).rejects.toThrow("Refresh token not found");
  });

  it("throws UNAUTHORIZED for expired stored token", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { signRefreshToken, refresh } = await import("../app/src/modules/auth/auth.service");

    const token = signRefreshToken("user-1");

    // Return expired token from DB
    (prisma.refreshToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      token,
      userId: "user-1",
      expiresAt: new Date(Date.now() - 1000), // expired
    });
    (prisma.refreshToken.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    await expect(refresh(token)).rejects.toThrow("Refresh token has expired");
  });

  it("rotates token on successful refresh", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { signRefreshToken, refresh } = await import("../app/src/modules/auth/auth.service");

    const oldToken = signRefreshToken("user-1");

    (prisma.refreshToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      token: oldToken,
      userId: "user-1",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // valid
    });
    (prisma.refreshToken.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});
    (prisma.refreshToken.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    const result = await refresh(oldToken);

    expect(result.accessToken).toBeDefined();
    expect(typeof result.accessToken).toBe("string");
    expect(result.refreshToken).toBeDefined();
    expect(typeof result.refreshToken).toBe("string");
    // Verify token rotation happened (old deleted, new created)
    expect(prisma.refreshToken.delete).toHaveBeenCalledWith({ where: { token: oldToken } });
    expect(prisma.refreshToken.create).toHaveBeenCalled();
  });

  it("throws UNAUTHORIZED for invalid JWT signature in refresh", async () => {
    const { refresh } = await import("../app/src/modules/auth/auth.service");

    await expect(refresh("invalid.jwt.token")).rejects.toThrow();
  });
});

describe("logout service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes the specific refresh token for user", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { logout } = await import("../app/src/modules/auth/auth.service");

    (prisma.refreshToken.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 1 });

    await logout("user-1", "some-refresh-token");

    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { token: "some-refresh-token", userId: "user-1" },
    });
  });
});

describe("logoutAll service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes all refresh tokens for user", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { logoutAll } = await import("../app/src/modules/auth/auth.service");

    (prisma.refreshToken.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 3 });

    await logoutAll("user-1");

    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
  });
});

describe("verifyAccessToken — edge cases", () => {
  it("throws for null input", async () => {
    const { verifyAccessToken } = await import("../app/src/modules/auth/auth.service");
    expect(() => verifyAccessToken(null as unknown as string)).toThrow();
  });

  it("throws for number input", async () => {
    const { verifyAccessToken } = await import("../app/src/modules/auth/auth.service");
    expect(() => verifyAccessToken(12345 as unknown as string)).toThrow();
  });

  it("throws for whitespace-only token", async () => {
    const { verifyAccessToken } = await import("../app/src/modules/auth/auth.service");
    expect(() => verifyAccessToken("   ")).toThrow();
  });
});
