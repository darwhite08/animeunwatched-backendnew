/**
 * Advanced auth schema tests — all edge cases.
 */
import { describe, it, expect } from "vitest";
import { registerSchema, loginSchema, googleLoginSchema, appleLoginSchema } from "../app/src/modules/auth/auth.schema";

describe("registerSchema — username edge cases", () => {
  const base = { email: "a@b.com", username: "user123", displayName: "User", password: "Password1!" };

  it("accepts username with only underscores (valid)", () => {
    expect(() => registerSchema.parse({ ...base, username: "___" })).not.toThrow();
  });

  it("accepts username starting with uppercase", () => {
    expect(() => registerSchema.parse({ ...base, username: "User123" })).not.toThrow();
  });

  it("rejects username with spaces", () => {
    expect(() => registerSchema.parse({ ...base, username: "user 123" })).toThrow();
  });

  it("rejects username with dots", () => {
    expect(() => registerSchema.parse({ ...base, username: "user.name" })).toThrow();
  });

  it("rejects username with @", () => {
    expect(() => registerSchema.parse({ ...base, username: "user@name" })).toThrow();
  });

  it("rejects username with dashes", () => {
    expect(() => registerSchema.parse({ ...base, username: "user-name" })).toThrow();
  });
});

describe("registerSchema — email edge cases", () => {
  const base = { username: "user123", displayName: "User", password: "Password1!" };

  it("accepts email with + alias", () => {
    expect(() => registerSchema.parse({ ...base, email: "user+alias@example.com" })).not.toThrow();
  });

  it("accepts email with subdomain", () => {
    expect(() => registerSchema.parse({ ...base, email: "user@sub.example.com" })).not.toThrow();
  });

  it("accepts email with numbers", () => {
    expect(() => registerSchema.parse({ ...base, email: "user123@example123.com" })).not.toThrow();
  });

  it("rejects email without TLD", () => {
    expect(() => registerSchema.parse({ ...base, email: "user@domain" })).toThrow();
  });

  it("rejects email with multiple @", () => {
    expect(() => registerSchema.parse({ ...base, email: "user@@domain.com" })).toThrow();
  });
});

describe("registerSchema — password edge cases", () => {
  const base = { email: "a@b.com", username: "user123", displayName: "User" };

  it("accepts password with spaces meeting complexity rules", () => {
    expect(() => registerSchema.parse({ ...base, password: "My Pass1!  " })).not.toThrow();
  });

  it("accepts password with special chars", () => {
    expect(() => registerSchema.parse({ ...base, password: "P@$$w0rd!#9" })).not.toThrow();
  });

  it("accepts password with unicode (counts as special)", () => {
    // パスワードAa1! is only 9 chars; pad to meet 10-char minimum
    expect(() => registerSchema.parse({ ...base, password: "パスワードAa1!xy" })).not.toThrow();
  });

  it("rejects password under new 10-char minimum", () => {
    expect(() => registerSchema.parse({ ...base, password: "Pass1!ab" })).toThrow();
  });

  it("accepts password at exactly 10 chars with complexity", () => {
    expect(() => registerSchema.parse({ ...base, password: "Pass1234!a" })).not.toThrow();
  });

  it("rejects common password from denylist (case-insensitive)", () => {
    // "qwerty123" is in the denylist — case-insensitive check should reject "Qwerty123"
    expect(() => registerSchema.parse({ ...base, password: "Qwerty123" })).toThrow();
  });
});

describe("loginSchema — comprehensive", () => {
  it("accepts minimal valid login", () => {
    expect(() => loginSchema.parse({ email: "a@b.com", password: "x" })).not.toThrow();
  });

  it("accepts long email and password", () => {
    expect(() => loginSchema.parse({
      email: "user+very.long.alias@very-long-subdomain.example.com",
      password: "a".repeat(128),
    })).not.toThrow();
  });

  it("fails without email", () => {
    expect(() => loginSchema.parse({ password: "pass" })).toThrow();
  });

  it("fails without password", () => {
    expect(() => loginSchema.parse({ email: "a@b.com" })).toThrow();
  });

  it("fails with empty object", () => {
    expect(() => loginSchema.parse({})).toThrow();
  });
});

describe("googleLoginSchema — edge cases", () => {
  it("accepts any non-empty string as idToken", () => {
    expect(() => googleLoginSchema.parse({ idToken: "short" })).not.toThrow();
    expect(() => googleLoginSchema.parse({ idToken: "a".repeat(1000) })).not.toThrow();
  });

  it("rejects null idToken", () => {
    expect(() => googleLoginSchema.parse({ idToken: null })).toThrow();
  });

  it("rejects missing idToken", () => {
    expect(() => googleLoginSchema.parse({})).toThrow();
  });
});

describe("appleLoginSchema — edge cases", () => {
  it("accepts with all optional fields", () => {
    expect(() => appleLoginSchema.parse({
      idToken: "token",
      email: "user@icloud.com",
      firstName: "Jane",
      lastName: "Doe",
    })).not.toThrow();
  });

  it("accepts with only required idToken", () => {
    expect(() => appleLoginSchema.parse({ idToken: "token" })).not.toThrow();
  });

  it("rejects invalid email in optional field", () => {
    expect(() => appleLoginSchema.parse({ idToken: "t", email: "notvalid" })).toThrow();
  });
});
