import crypto from "node:crypto";

/**
 * RFC 6238 TOTP (Time-based One-Time Password) — HMAC-SHA-1, 6 digits, 30 s.
 * Pure Node crypto, no third-party deps. Self-tested against the RFC vector
 * in tests/totp.test.ts.
 */

const BASE32_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateSecretBase32(bytes = 20): string {
  const buf = crypto.randomBytes(bytes);
  let bits = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32_ALPHA[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = "";
  for (const c of clean) {
    const v = BASE32_ALPHA.indexOf(c);
    if (v < 0) throw new Error(`Invalid base32 char: ${c}`);
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secretBase32: string, atSeconds: number = Math.floor(Date.now() / 1000)): string {
  const counter = Math.floor(atSeconds / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", base32Decode(secretBase32)).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}

/**
 * Verify a 6-digit code against the secret, allowing ±1 time-step skew
 * (covers clock drift + a code entered right at the boundary).
 */
export function verifyTotp(secretBase32: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const now = Math.floor(Date.now() / 1000);
  for (const drift of [-30, 0, 30]) {
    if (totp(secretBase32, now + drift) === code) return true;
  }
  return false;
}

/**
 * Build a Google Authenticator / Authy compatible otpauth URL.
 * Frontend renders this as a QR code.
 */
export function otpauthUrl(opts: { issuer: string; account: string; secretBase32: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  const params = new URLSearchParams({
    secret:    opts.secretBase32,
    issuer:    opts.issuer,
    algorithm: "SHA1",
    digits:    "6",
    period:    "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function generateBackupCodes(count = 8): string[] {
  return Array.from({ length: count }, () =>
    crypto.randomBytes(5).toString("hex").toUpperCase().match(/.{1,5}/g)!.join("-"),
  );
}

export function hashBackupCode(code: string): string {
  return crypto.createHash("sha256").update(code.replace(/-/g, "").toUpperCase()).digest("hex");
}
