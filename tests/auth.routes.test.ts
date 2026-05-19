/**
 * Auth schema end-to-end validation tests — tests that all inputs are properly validated
 * before reaching the service layer.
 */
import { describe, it, expect } from "vitest";
import { registerSchema, loginSchema } from "../app/src/modules/auth/auth.schema";

// ── Boundary value tests ──────────────────────────────────────────────────────

describe("registerSchema — boundary values", () => {
  const valid = { email: "a@b.com", username: "user123", displayName: "User", password: "Password1!" };

  it("rejects username with exactly 2 chars", () => {
    expect(() => registerSchema.parse({ ...valid, username: "ab" })).toThrow();
  });

  it("accepts username with exactly 3 chars", () => {
    expect(() => registerSchema.parse({ ...valid, username: "abc" })).not.toThrow();
  });

  it("accepts username with exactly 30 chars", () => {
    expect(() => registerSchema.parse({ ...valid, username: "a".repeat(30) })).not.toThrow();
  });

  it("rejects username with exactly 31 chars", () => {
    expect(() => registerSchema.parse({ ...valid, username: "a".repeat(31) })).toThrow();
  });

  it("rejects password with exactly 7 chars", () => {
    expect(() => registerSchema.parse({ ...valid, password: "1234567" })).toThrow();
  });

  it("accepts password with exactly 8 chars", () => {
    expect(() => registerSchema.parse({ ...valid, password: "12345678" })).not.toThrow();
  });

  it("rejects password with exactly 129 chars", () => {
    expect(() => registerSchema.parse({ ...valid, password: "a".repeat(129) })).toThrow();
  });

  it("accepts password with exactly 128 chars", () => {
    expect(() => registerSchema.parse({ ...valid, password: "a".repeat(128) })).not.toThrow();
  });

  it("rejects email with missing @", () => {
    expect(() => registerSchema.parse({ ...valid, email: "notanemail" })).toThrow();
  });

  it("rejects email with no domain", () => {
    expect(() => registerSchema.parse({ ...valid, email: "user@" })).toThrow();
  });

  it("rejects displayName over 60 chars", () => {
    expect(() => registerSchema.parse({ ...valid, displayName: "a".repeat(61) })).toThrow();
  });

  it("accepts displayName with exactly 60 chars", () => {
    expect(() => registerSchema.parse({ ...valid, displayName: "a".repeat(60) })).not.toThrow();
  });

  it("accepts username with only alphanumeric and underscores", () => {
    expect(() => registerSchema.parse({ ...valid, username: "user_123" })).not.toThrow();
    expect(() => registerSchema.parse({ ...valid, username: "User123" })).not.toThrow();
  });

  it("rejects username with special characters", () => {
    expect(() => registerSchema.parse({ ...valid, username: "user-name" })).toThrow();
    expect(() => registerSchema.parse({ ...valid, username: "user.name" })).toThrow();
    expect(() => registerSchema.parse({ ...valid, username: "user@name" })).toThrow();
  });
});

describe("loginSchema — validation", () => {
  it("accepts valid email and password", () => {
    expect(() => loginSchema.parse({ email: "user@example.com", password: "p" })).not.toThrow();
  });

  it("rejects empty body", () => {
    expect(() => loginSchema.parse({})).toThrow();
  });

  it("rejects invalid email format", () => {
    expect(() => loginSchema.parse({ email: "notanemail", password: "pass" })).toThrow();
  });

  it("accepts any non-empty password for login (server validates credentials)", () => {
    // Login schema only validates email format, not password strength
    // (password strength is only validated on register)
    expect(() => loginSchema.parse({ email: "a@b.com", password: "x" })).not.toThrow();
  });
});
