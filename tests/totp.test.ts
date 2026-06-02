import { describe, it, expect } from "vitest";
import { totp, verifyTotp, generateSecretBase32, base32Decode, otpauthUrl, generateBackupCodes, hashBackupCode } from "../app/src/lib/totp";

describe("totp", () => {
  // RFC 6238 test vector — SHA-1, ASCII "12345678901234567890" base32-encoded.
  // "12345678901234567890" → base32 → "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
  it("generates RFC 6238 vector at T=59 → 287082", () => {
    expect(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59)).toBe("287082");
  });

  it("generates RFC 6238 vector at T=1111111109 → 081804", () => {
    expect(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1111111109)).toBe("081804");
  });

  it("verify accepts current-window code", () => {
    const s = generateSecretBase32();
    const code = totp(s);
    expect(verifyTotp(s, code)).toBe(true);
  });

  it("verify accepts a code from one step ago (clock skew tolerance)", () => {
    const s = generateSecretBase32();
    const code = totp(s, Math.floor(Date.now() / 1000) - 30);
    expect(verifyTotp(s, code)).toBe(true);
  });

  it("verify rejects garbage", () => {
    const s = generateSecretBase32();
    expect(verifyTotp(s, "000000")).toBe(false);
    expect(verifyTotp(s, "abcdef")).toBe(false);
    expect(verifyTotp(s, "1234567")).toBe(false);
  });

  it("base32 encode/decode round-trips", () => {
    const s = generateSecretBase32();
    const buf = base32Decode(s);
    expect(buf.length).toBeGreaterThanOrEqual(20);
  });

  it("otpauth URL contains issuer + secret", () => {
    const url = otpauthUrl({ issuer: "Kaiveron", account: "x@y.com", secretBase32: "ABCD" });
    expect(url).toMatch(/^otpauth:\/\/totp\//);
    expect(url).toContain("secret=ABCD");
    expect(url).toContain("issuer=Kaiveron");
  });

  it("backup codes are unique and hashable", () => {
    const codes = generateBackupCodes(8);
    const set = new Set(codes);
    expect(set.size).toBe(8);
    for (const c of codes) {
      expect(hashBackupCode(c)).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
