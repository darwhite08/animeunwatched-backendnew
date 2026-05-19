/**
 * JWT token tests — comprehensive coverage of JWT sign/verify behavior.
 */
import { describe, it, expect, vi } from "vitest";
import jwt from "jsonwebtoken";

const ACCESS_SECRET  = "test-access-secret-min-32-chars-long!";
const REFRESH_SECRET = "test-refresh-secret-min-32-chars-long!";

// Test the actual JWT functions from auth.service
describe("JWT signing", () => {
  it("signAccessToken produces a valid JWT", async () => {
    const { signAccessToken, verifyAccessToken } = await import("../app/src/modules/auth/auth.service");
    const token = signAccessToken("user-123");

    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3); // header.payload.signature

    const decoded = verifyAccessToken(token);
    expect(decoded.userId).toBe("user-123");
  });

  it("signRefreshToken produces a different token from access token", async () => {
    const { signAccessToken, signRefreshToken } = await import("../app/src/modules/auth/auth.service");
    const accessToken  = signAccessToken("user-123");
    const refreshToken = signRefreshToken("user-123");

    expect(accessToken).not.toBe(refreshToken);
  });

  it("verifyAccessToken rejects refresh token (signed with wrong secret)", async () => {
    const { signRefreshToken, verifyAccessToken } = await import("../app/src/modules/auth/auth.service");
    const refreshToken = signRefreshToken("user-123");

    // A refresh token signed with the refresh secret should NOT be verifiable as an access token
    expect(() => verifyAccessToken(refreshToken)).toThrow();
  });

  it("verifyRefreshToken rejects access token", async () => {
    const { signAccessToken, verifyRefreshToken } = await import("../app/src/modules/auth/auth.service");
    const accessToken = signAccessToken("user-123");

    expect(() => verifyRefreshToken(accessToken)).toThrow();
  });

  it("expired access token throws UNAUTHORIZED", async () => {
    const { verifyAccessToken } = await import("../app/src/modules/auth/auth.service");
    // Create a token that expired 1 second ago
    const expiredToken = jwt.sign({ userId: "user-1" }, ACCESS_SECRET, { expiresIn: "-1s" as any });
    expect(() => verifyAccessToken(expiredToken)).toThrow("Invalid or expired access token");
  });

  it("token payload contains userId", async () => {
    const { signAccessToken } = await import("../app/src/modules/auth/auth.service");
    const token = signAccessToken("specific-user-id");
    const decoded = jwt.decode(token) as { userId: string; iat: number; exp: number };

    expect(decoded.userId).toBe("specific-user-id");
    expect(decoded.iat).toBeDefined();
    expect(decoded.exp).toBeDefined();
    expect(decoded.exp).toBeGreaterThan(decoded.iat);
  });

  it("access token has 15-minute default expiry", async () => {
    const { signAccessToken } = await import("../app/src/modules/auth/auth.service");
    const token = signAccessToken("user-1");
    const decoded = jwt.decode(token) as { iat: number; exp: number };

    const durationSeconds = decoded.exp - decoded.iat;
    // Should be ~15 minutes (900 seconds)
    expect(durationSeconds).toBeGreaterThanOrEqual(899);
    expect(durationSeconds).toBeLessThanOrEqual(901);
  });
});

describe("JWT tampering detection", () => {
  it("detects signature tampering", async () => {
    const { signAccessToken, verifyAccessToken } = await import("../app/src/modules/auth/auth.service");
    const token = signAccessToken("user-1");

    // Tamper with the payload by replacing the last character
    const parts = token.split(".");
    const tamperedPayload = parts[1].slice(0, -2) + "XX";
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    expect(() => verifyAccessToken(tamperedToken)).toThrow();
  });

  it("detects signature replacement", async () => {
    const { signAccessToken, verifyAccessToken } = await import("../app/src/modules/auth/auth.service");
    const token1 = signAccessToken("user-1");
    const token2 = signAccessToken("user-2");

    // Mix header+payload from token1 with signature from token2
    const parts1 = token1.split(".");
    const parts2 = token2.split(".");
    const mixedToken = `${parts1[0]}.${parts1[1]}.${parts2[2]}`;

    expect(() => verifyAccessToken(mixedToken)).toThrow();
  });
});
