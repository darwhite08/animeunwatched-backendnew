/**
 * Auth edge case tests — password hashing performance, token uniqueness.
 */
import { describe, it, expect, vi } from "vitest";
import { hashPassword, verifyPassword, signAccessToken, signRefreshToken } from "../app/src/modules/auth/auth.service";

vi.mock("../app/src/config/prisma", () => ({
  prisma: { user: { findUnique: vi.fn() }, refreshToken: { create: vi.fn(), findUnique: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() } },
}));
vi.mock("../app/src/lib/email", () => ({ sendEmail: vi.fn(), welcomeEmail: vi.fn() }));

describe("password hashing", () => {
  it("hashes with argon2 (hash starts with $argon2id$)", async () => {
    const hash = await hashPassword("testpassword")
    expect(hash).toContain("$argon2id$")
  })

  it("empty string can be hashed", async () => {
    const hash = await hashPassword("")
    expect(typeof hash).toBe("string")
    expect(hash.length).toBeGreaterThan(0)
  })

  it("very long password hashes successfully", async () => {
    const longPass = "a".repeat(128)
    const hash = await hashPassword(longPass)
    expect(await verifyPassword(hash, longPass)).toBe(true)
  })

  it("password with special characters hashes correctly", async () => {
    const specialPass = "p@$$w0rd!#%^&*()"
    const hash = await hashPassword(specialPass)
    expect(await verifyPassword(hash, specialPass)).toBe(true)
  })

  it("unicode passwords hash and verify correctly", async () => {
    const unicodePass = "パスワード123"
    const hash = await hashPassword(unicodePass)
    expect(await verifyPassword(hash, unicodePass)).toBe(true)
    expect(await verifyPassword(hash, "パスワード124")).toBe(false) // wrong
  })
})

describe("JWT token uniqueness and format", () => {
  it("two access tokens for same user in sequence differ (different timestamps)", async () => {
    // Wait 1 second to get different iat
    const t1 = signAccessToken("user-1")
    await new Promise(r => setTimeout(r, 1100))
    const t2 = signAccessToken("user-1")
    // Different timestamps → different tokens
    expect(t1).not.toBe(t2)
  })

  it("tokens have 3 parts separated by dots", () => {
    const token = signAccessToken("user-1")
    const parts = token.split(".")
    expect(parts).toHaveLength(3)
  })

  it("token header is base64url JSON", () => {
    const token = signAccessToken("user-1")
    const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString())
    expect(header.alg).toBe("HS256")
    expect(header.typ).toBe("JWT")
  })

  it("token payload contains userId and iat", () => {
    const token = signAccessToken("specific-id")
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
    expect(payload.userId).toBe("specific-id")
    expect(typeof payload.iat).toBe("number")
    expect(typeof payload.exp).toBe("number")
    expect(payload.exp).toBeGreaterThan(payload.iat)
  })
})
