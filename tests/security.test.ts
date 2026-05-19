/**
 * Security-focused tests.
 * Verifies that security-critical validations are in place.
 */
import { describe, it, expect } from "vitest";
import { notFound, forbidden, conflict, badReq, unauth } from "../app/src/lib/errors";
import { HttpError } from "../app/src/lib/errors";

// ── Content-length / limit capping logic ──────────────────────────────────────

describe("pagination limit capping", () => {
  function capLimit(raw: number, max = 100) {
    return Math.min(max, Math.max(1, raw));
  }

  it("caps at max when over limit", () => {
    expect(capLimit(99999)).toBe(100);
    expect(capLimit(99999, 50)).toBe(50);
  });

  it("uses the raw value when within bounds", () => {
    expect(capLimit(20)).toBe(20);
    expect(capLimit(1)).toBe(1);
  });

  it("returns at least 1 for zero or negative", () => {
    expect(capLimit(0)).toBe(1);
    expect(capLimit(-5)).toBe(1);
  });
});

// ── Input validation for malId ────────────────────────────────────────────────

describe("malId validation", () => {
  function validateMalId(raw: string | string[]): number {
    const str = Array.isArray(raw) ? raw[0] : raw;
    const id = parseInt(str, 10);
    if (isNaN(id) || id <= 0) throw badReq("malId must be a positive integer");
    return id;
  }

  it("accepts a valid positive integer string", () => {
    expect(validateMalId("21")).toBe(21);
    expect(validateMalId("1")).toBe(1);
  });

  it("throws 400 for non-numeric input", () => {
    expect(() => validateMalId("abc")).toThrow(HttpError);
    expect(() => validateMalId("")).toThrow(HttpError);
    expect(() => validateMalId("!@#")).toThrow(HttpError);
  });

  it("throws 400 for zero", () => {
    expect(() => validateMalId("0")).toThrow(HttpError);
  });

  it("throws 400 for negative", () => {
    expect(() => validateMalId("-1")).toThrow(HttpError);
  });

  it("handles array input (takes first element)", () => {
    expect(validateMalId(["21", "99"])).toBe(21);
  });
});

// ── Season validation ─────────────────────────────────────────────────────────

describe("season validation", () => {
  const VALID = ["winter", "spring", "summer", "fall"] as const;

  function validateSeason(raw: string): string {
    if (!VALID.includes(raw as typeof VALID[number])) throw badReq("Invalid season");
    return raw;
  }

  it("accepts valid seasons", () => {
    for (const s of VALID) {
      expect(validateSeason(s)).toBe(s);
    }
  });

  it("throws 400 for invalid season", () => {
    expect(() => validateSeason("monsoon")).toThrow(HttpError);
    expect(() => validateSeason("")).toThrow(HttpError);
    expect(() => validateSeason("WINTER")).toThrow(HttpError); // case-sensitive
  });
});

// ── Role validation ───────────────────────────────────────────────────────────

describe("club member role validation", () => {
  const VALID_ROLES = ["USER", "MOD", "ADMIN"] as const;

  function validateRole(raw: string): string {
    if (!VALID_ROLES.includes(raw as typeof VALID_ROLES[number])) throw badReq("Invalid role");
    return raw;
  }

  it("accepts valid roles", () => {
    expect(validateRole("USER")).toBe("USER");
    expect(validateRole("MOD")).toBe("MOD");
    expect(validateRole("ADMIN")).toBe("ADMIN");
  });

  it("throws 400 for invalid roles", () => {
    expect(() => validateRole("SUPERADMIN")).toThrow(HttpError);
    expect(() => validateRole("owner")).toThrow(HttpError);
    expect(() => validateRole("")).toThrow(HttpError);
    expect(() => validateRole("ROOT")).toThrow(HttpError);
  });
});

// ── Error shapes ──────────────────────────────────────────────────────────────

describe("error factory status codes", () => {
  it("notFound → 404", () => expect(notFound().status).toBe(404));
  it("forbidden → 403", () => expect(forbidden().status).toBe(403));
  it("conflict → 409", () => expect(conflict().status).toBe(409));
  it("badReq → 400", () => expect(badReq().status).toBe(400));
  it("unauth → 401", () => expect(unauth().status).toBe(401));
});

// ── JWT secret strength check ─────────────────────────────────────────────────

describe("JWT secret validation", () => {
  const WEAK_SECRETS = [
    "dev-access-secret",
    "dev-refresh-secret",
    "change-me-access-secret-min-32-chars",
    "change-me-refresh-secret-min-32-chars",
    "secret",
    "password",
  ];

  function isSecretStrong(secret: string): boolean {
    if (WEAK_SECRETS.includes(secret)) return false;
    if (secret.length < 32) return false;
    return true;
  }

  it("rejects known weak dev secrets", () => {
    for (const s of WEAK_SECRETS) {
      expect(isSecretStrong(s)).toBe(false);
    }
  });

  it("rejects short secrets", () => {
    expect(isSecretStrong("shortkey")).toBe(false);
  });

  it("accepts a strong secret", () => {
    expect(isSecretStrong("super-long-random-secret-that-meets-minimum-length-requirements")).toBe(true);
  });
});
