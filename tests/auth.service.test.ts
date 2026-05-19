/**
 * Auth service unit tests — all Prisma calls are mocked via vi.mock.
 * No real database required.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from "../app/src/modules/auth/auth.service";
import { HttpError } from "../app/src/lib/errors";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
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

// ── Password hashing ──────────────────────────────────────────────────────────

describe("hashPassword / verifyPassword", () => {
  it("hashes a password and verifies it correctly", async () => {
    const plain = "hunter2_SuperSecret!";
    const hash = await hashPassword(plain);

    expect(hash).not.toBe(plain);
    expect(hash.length).toBeGreaterThan(20);

    const isValid = await verifyPassword(hash, plain);
    expect(isValid).toBe(true);
  });

  it("returns false for a wrong password", async () => {
    const hash = await hashPassword("correct-horse-battery");
    const isValid = await verifyPassword(hash, "wrong-password");
    expect(isValid).toBe(false);
  });

  it("produces different hashes for the same password (salt randomness)", async () => {
    const plain = "same-password";
    const hash1 = await hashPassword(plain);
    const hash2 = await hashPassword(plain);
    expect(hash1).not.toBe(hash2);
  });
});

// ── JWT helpers ───────────────────────────────────────────────────────────────

describe("JWT access tokens", () => {
  const userId = "user-abc-123";

  it("signs and verifies a valid access token", () => {
    const token = signAccessToken(userId);
    const decoded = verifyAccessToken(token);
    expect(decoded.userId).toBe(userId);
  });

  it("throws UNAUTHORIZED for a tampered access token", () => {
    const token = signAccessToken(userId);
    const tampered = token.slice(0, -3) + "xxx";
    expect(() => verifyAccessToken(tampered)).toThrow(HttpError);
    expect(() => verifyAccessToken(tampered)).toThrow("Invalid or expired access token");
  });

  it("throws UNAUTHORIZED for an empty string", () => {
    expect(() => verifyAccessToken("")).toThrow(HttpError);
  });
});

describe("JWT refresh tokens", () => {
  const userId = "user-xyz-456";

  it("signs and verifies a valid refresh token", () => {
    const token = signRefreshToken(userId);
    const decoded = verifyRefreshToken(token);
    expect(decoded.userId).toBe(userId);
  });

  it("throws UNAUTHORIZED for a forged refresh token", () => {
    // Sign with wrong secret simulation (different userId produces different token)
    const realToken = signRefreshToken("other-user");
    const altered = realToken.replace(/\./g, "x");
    expect(() => verifyRefreshToken(altered)).toThrow(HttpError);
  });

  it("refresh token is different from access token for same userId", () => {
    const access  = signAccessToken(userId);
    const refresh = signRefreshToken(userId);
    expect(access).not.toBe(refresh);
  });
});

// ── Register service (mocked Prisma) ─────────────────────────────────────────

describe("register service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws CONFLICT when email already exists", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { register } = await import("../app/src/modules/auth/auth.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: "existing", email: "used@example.com" })  // email check
      .mockResolvedValueOnce(null);                                           // username check

    await expect(register({
      email: "used@example.com",
      username: "newuser",
      displayName: "New User",
      password: "Password1!",
    })).rejects.toThrow("Email is already in use");
  });

  it("throws CONFLICT when username already exists", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { register } = await import("../app/src/modules/auth/auth.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)                                           // email check
      .mockResolvedValueOnce({ id: "existing", username: "taken" });        // username check

    await expect(register({
      email: "new@example.com",
      username: "taken",
      displayName: "New User",
      password: "Password1!",
    })).rejects.toThrow("Username is already taken");
  });

  it("successfully registers a new user and returns tokens", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { register } = await import("../app/src/modules/auth/auth.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)   // email check
      .mockResolvedValueOnce(null);  // username check

    const mockUser = {
      id: "new-user-id",
      email: "fresh@example.com",
      username: "freshuser",
      displayName: "Fresh User",
      bio: null,
      avatarUrl: null,
      role: "USER",
      reputation: 0,
      createdAt: new Date(),
    };

    (prisma.user.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockUser);
    (prisma.refreshToken.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    const result = await register({
      email: "fresh@example.com",
      username: "freshuser",
      displayName: "Fresh User",
      password: "Password1!",
    });

    expect(result.user.email).toBe("fresh@example.com");
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(result.accessToken).not.toBe(result.refreshToken);
  });
});

// ── Login service ─────────────────────────────────────────────────────────────

describe("login service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws UNAUTHORIZED when user not found", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { login } = await import("../app/src/modules/auth/auth.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(login({ email: "ghost@example.com", password: "pass" }))
      .rejects.toThrow("Invalid email or password");
  });

  it("throws UNAUTHORIZED when password is wrong", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { login } = await import("../app/src/modules/auth/auth.service");

    const realHash = await hashPassword("correct-password");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "u1", email: "user@example.com", username: "u", displayName: "U",
      bio: null, avatarUrl: null, role: "USER", reputation: 0, isBanned: false,
      createdAt: new Date(), passwordHash: realHash,
    });

    await expect(login({ email: "user@example.com", password: "wrong-password" }))
      .rejects.toThrow("Invalid email or password");
  });

  it("returns tokens on successful login", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { login } = await import("../app/src/modules/auth/auth.service");

    const realHash = await hashPassword("MyPassword1!");
    // The optimized login now makes a single query that includes passwordHash + safe fields
    const mockUser = {
      id: "u1",
      email: "user@example.com",
      username: "user1",
      displayName: "User One",
      bio: null,
      avatarUrl: null,
      role: "USER",
      reputation: 0,
      isBanned: false,
      createdAt: new Date(),
      passwordHash: realHash,  // included in single query
    };

    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockUser);  // single call includes hash

    (prisma.refreshToken.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    const result = await login({ email: "user@example.com", password: "MyPassword1!" });

    expect(result.user.email).toBe("user@example.com");
    // passwordHash should be stripped from result
    expect((result.user as { passwordHash?: string }).passwordHash).toBeUndefined();
    expect(typeof result.accessToken).toBe("string");
    expect(typeof result.refreshToken).toBe("string");
  });
});

// ── HttpError shape ───────────────────────────────────────────────────────────

describe("HttpError", () => {
  it("has correct status and code", () => {
    const err = new HttpError(404, "NOT_FOUND", "Resource missing");
    expect(err.status).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Resource missing");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HttpError);
  });
});
