/**
 * Auth Zod schema validation tests.
 */
import { describe, it, expect } from "vitest";
import { registerSchema, loginSchema, googleLoginSchema, appleLoginSchema } from "../app/src/modules/auth/auth.schema";

describe("registerSchema", () => {
  const valid = {
    email: "user@example.com",
    username: "user_123",
    displayName: "My Name",
    password: "SecurePass1!",
  };

  it("passes with valid data", () => {
    expect(() => registerSchema.parse(valid)).not.toThrow();
  });

  it("fails with invalid email", () => {
    expect(() => registerSchema.parse({ ...valid, email: "not-an-email" })).toThrow();
  });

  it("fails with username too short", () => {
    expect(() => registerSchema.parse({ ...valid, username: "ab" })).toThrow();
  });

  it("fails with username containing special chars", () => {
    expect(() => registerSchema.parse({ ...valid, username: "bad user!" })).toThrow();
  });

  it("fails with password too short", () => {
    expect(() => registerSchema.parse({ ...valid, password: "short" })).toThrow();
  });

  it("fails with empty displayName", () => {
    expect(() => registerSchema.parse({ ...valid, displayName: "" })).toThrow();
  });

  it("allows underscores and numbers in username", () => {
    expect(() => registerSchema.parse({ ...valid, username: "user_123" })).not.toThrow();
  });
});

describe("loginSchema", () => {
  it("passes with valid credentials", () => {
    expect(() => loginSchema.parse({ email: "u@x.com", password: "any" })).not.toThrow();
  });

  it("fails with missing email", () => {
    expect(() => loginSchema.parse({ password: "pass" })).toThrow();
  });

  it("fails with invalid email format", () => {
    expect(() => loginSchema.parse({ email: "bad", password: "pass" })).toThrow();
  });
});

describe("googleLoginSchema", () => {
  it("passes with a token", () => {
    expect(() => googleLoginSchema.parse({ idToken: "google-id-token" })).not.toThrow();
  });

  it("fails with empty token", () => {
    expect(() => googleLoginSchema.parse({ idToken: "" })).toThrow();
  });
});

describe("appleLoginSchema", () => {
  it("passes with just idToken", () => {
    expect(() => appleLoginSchema.parse({ idToken: "apple-token" })).not.toThrow();
  });

  it("passes with optional fields", () => {
    expect(() => appleLoginSchema.parse({
      idToken: "token",
      email: "user@icloud.com",
      firstName: "Jane",
      lastName: "Doe",
    })).not.toThrow();
  });

  it("fails with invalid email in optional field", () => {
    expect(() => appleLoginSchema.parse({ idToken: "t", email: "not-email" })).toThrow();
  });
});
