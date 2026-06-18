import argon2 from "argon2";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import appleSignin from "apple-signin-auth";
import { generateUniqueSlug } from "../../lib/slug";
import { updateStreak } from "../../lib/streak";
import { verifyTotp, hashBackupCode } from "../../lib/totp";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { conflict, unauth, badRequest, forbidden } from "../../lib/errors";
import { enforceSignupGate, getInviteOnly } from "../../lib/inviteGate";
import { createNotification, NotificationType } from "../../lib/notify";
import { sendEmail, welcomeEmail, verificationEmail, isEmailConfigured } from "../../lib/email";
import { recordSecurityEvent } from "../../lib/audit";
import { broadcastAdminUserSignup } from "../../realtime/broadcast";
import type { RegisterDto, LoginDto, GoogleLoginDto, AppleLoginDto, ChangePasswordDto } from "./auth.schema";

const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);

// ---------- helpers ----------

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}

export function signAccessToken(userId: string): string {
  return jwt.sign({ userId }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRY as jwt.SignOptions["expiresIn"],
  });
}

/**
 * Issue a SCOPED access token for an impersonation session. The token's
 * sub is the target user (so downstream code "sees" the target's perspective)
 * but the JWT also carries impersonatorId + sessionId so the auth middleware
 * can validate the session is still active and audit-tag every request.
 */
export function signImpersonationToken(opts: {
  targetUserId:   string;
  impersonatorId: string;
  sessionId:      string;
  expiresInSec:   number;
}): string {
  return jwt.sign(
    { userId: opts.targetUserId, impersonatorId: opts.impersonatorId, impSessionId: opts.sessionId },
    env.JWT_ACCESS_SECRET,
    { expiresIn: opts.expiresInSec },
  );
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ userId }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRY as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): { userId: string } {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as { userId: string };
  } catch {
    throw unauth("Invalid or expired access token");
  }
}

export function verifyRefreshToken(token: string): { userId: string } {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as { userId: string };
  } catch {
    throw unauth("Invalid or expired refresh token");
  }
}

// ---------- safe user select ----------

const userSelect = {
  id: true,
  email: true,
  emailVerifiedAt: true,
  username: true,
  slug: true,         // routing alias — never used for data access
  displayName: true,
  bio: true,
  avatarUrl: true,
  coverImage: true,
  role: true,
  reputation: true,
  verifiedKind: true, communityLead: true,
  onboardedAt: true,
  streakDays: true,   // real streak tracking (not rep-estimate)
  bestStreak: true,
  lastActiveAt: true,
  createdAt: true,
} as const;

// ---------- service methods ----------

export async function register(dto: RegisterDto, meta: AuthMeta = {}) {
  // Invite-only gate (no-op unless an admin turned it on). Atomically consumes a
  // code; throws if the gate is on and the code is missing/invalid/exhausted.
  await enforceSignupGate(dto.inviteCode);

  const [existingEmail, existingUsername] = await Promise.all([
    prisma.user.findUnique({ where: { email: dto.email } }),
    // Case-insensitive: "aniversex" and "AniverseX" are the same handle.
    prisma.user.findFirst({ where: { username: { equals: dto.username, mode: "insensitive" } } }),
  ]);

  if (existingEmail) throw conflict("Email is already in use");
  if (existingUsername) throw conflict("Username is already taken");

  const passwordHash = await hashPassword(dto.password);
  // Generate a human-readable slug from displayName. Unique, never exposes userId.
  const slug = await generateUniqueSlug(dto.displayName || dto.username);

  // Email/password signups must confirm their address with a code — but ONLY
  // when email can actually be delivered. If SMTP isn't configured the code
  // would never arrive, so we mark them verified immediately (the gate stays
  // inert) rather than trapping them in an unverifiable state.
  const requireVerification = isEmailConfigured();

  // Resolve the referrer (by @handle) up front so we can persist the referral
  // graph edge on the new user — that's what powers "N people joined through
  // you". Self-referral is ignored.
  let referrer: { id: string; username: string } | null = null;
  if (dto.referredBy && dto.referredBy !== dto.username) {
    referrer = await prisma.user.findFirst({
      where: { username: { equals: dto.referredBy, mode: "insensitive" } },
      select: { id: true, username: true },
    });
  }

  const user = await prisma.user.create({
    data: {
      email: dto.email,
      username: dto.username,
      displayName: dto.displayName,
      slug,
      passwordHash,
      emailVerifiedAt: requireVerification ? null : new Date(),
      referredById: referrer?.id ?? null,
      signupPlatform: meta.platform ?? "unknown",
    },
    select: userSelect,
  });

  // Realtime signal to the admin dashboard (no-op if Socket.io isn't up yet).
  broadcastAdminUserSignup(user);

  if (requireVerification) {
    // Fire the verification code; don't send the welcome email until verified.
    await issueEmailVerification(user.id, dto.email, dto.displayName).catch(console.error);
  } else {
    sendEmail(welcomeEmail(dto.email, dto.displayName)).catch(console.error);
  }

  // Reward the referrer: +100 rep (feeds the reputation leaderboard) + a notification.
  if (referrer) {
    void (async () => {
      try {
        await prisma.user.update({ where: { id: referrer!.id }, data: { reputation: { increment: 100 } } });
        await createNotification({
          recipientId: referrer!.id,
          type: NotificationType.ACHIEVEMENT,
          payload: {
            message: `${dto.username} joined Kaiveron using your invite! +100 Rep for you.`,
            link: `/u/${dto.username}`,
          },
        });
      } catch { /* non-blocking */ }
    })();
  }

  const accessToken = signAccessToken(user.id);
  const refreshToken = signRefreshToken(user.id);

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: {
      token:     refreshToken,
      userId:    user.id,
      expiresAt,
      ipAddress: meta.ip        ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    },
  });

  return { user, accessToken, refreshToken };
}

// ─── Email verification (signup OTP) ──────────────────────────────────────────
// New email/password signups confirm their address with a 6-digit code before
// the account is fully active. Codes are stored hashed, expire quickly, and are
// attempt-capped. OAuth signups + existing users are verified without a code.
const EMAIL_CODE_TTL_MS      = 15 * 60 * 1000;  // code valid for 15 minutes
const EMAIL_CODE_MAX_ATTEMPTS = 6;              // wrong-code tries before lockout
const EMAIL_RESEND_COOLDOWN_MS = 60 * 1000;     // min gap between code sends

function generateEmailCode(): string {
  // 6 digits, uniformly random, zero-padded. crypto.randomInt avoids modulo bias.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashEmailCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

/**
 * Generate a fresh code, persist its hash (overwriting any pending one), and
 * email it. Used by register() and resendVerification(). Throws nothing fatal —
 * callers decide whether a send failure should surface.
 */
async function issueEmailVerification(userId: string, email: string, displayName: string): Promise<void> {
  const code = generateEmailCode();
  const expiresAt = new Date(Date.now() + EMAIL_CODE_TTL_MS);
  await prisma.emailVerification.upsert({
    where: { userId },
    create: { userId, codeHash: hashEmailCode(code), expiresAt, attempts: 0 },
    update: { codeHash: hashEmailCode(code), expiresAt, attempts: 0, sentAt: new Date() },
  });
  await sendEmail(verificationEmail(email, displayName, code));
}

/** Confirm the signup code. On success marks the account verified and clears the row. */
export async function verifyEmail(userId: string, code: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw unauth();
  if (user.emailVerifiedAt) {
    // Already verified — idempotent success (e.g. double-submit).
    return { user: await prisma.user.findUnique({ where: { id: userId }, select: userSelect }) };
  }

  const row = await prisma.emailVerification.findUnique({ where: { userId } });
  if (!row) throw badRequest("No verification is pending. Request a new code.", "NO_PENDING_VERIFICATION");

  if (row.expiresAt.getTime() < Date.now()) {
    throw badRequest("This code has expired. Request a new one.", "CODE_EXPIRED");
  }
  if (row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
    throw badRequest("Too many incorrect attempts. Request a new code.", "TOO_MANY_ATTEMPTS");
  }

  const matches = crypto.timingSafeEqual(
    Buffer.from(row.codeHash, "hex"),
    Buffer.from(hashEmailCode(code), "hex"),
  );
  if (!matches) {
    await prisma.emailVerification.update({ where: { userId }, data: { attempts: { increment: 1 } } });
    throw badRequest("That code isn't right. Check the digits and try again.", "INVALID_CODE");
  }

  // Correct: flip the flag and drop the pending row in one transaction.
  const [updated] = await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() }, select: userSelect }),
    prisma.emailVerification.delete({ where: { userId } }),
  ]);

  // Now that the address is confirmed, send the welcome email.
  sendEmail(welcomeEmail(updated.email, updated.displayName ?? updated.username)).catch(console.error);

  return { user: updated };
}

/** Re-send the signup code (rate-limited). No-op-success if already verified. */
export async function resendVerification(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw unauth();
  if (user.emailVerifiedAt) return { alreadyVerified: true };
  if (!isEmailConfigured()) {
    // Email can't be delivered — surface that rather than pretend a code is coming.
    throw badRequest("Email delivery isn't enabled yet. Contact support.", "EMAIL_NOT_CONFIGURED");
  }

  const existing = await prisma.emailVerification.findUnique({ where: { userId } });
  if (existing && Date.now() - existing.sentAt.getTime() < EMAIL_RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((EMAIL_RESEND_COOLDOWN_MS - (Date.now() - existing.sentAt.getTime())) / 1000);
    throw badRequest(`Please wait ${wait}s before requesting another code.`, "RESEND_COOLDOWN");
  }

  await issueEmailVerification(userId, user.email, user.displayName ?? user.username);
  return { sent: true };
}

// ─── Brute-force lockout (Postgres-backed, per email) ─────────────────────────
// Shared across instances (App Runner can run >1), so the lockout can't be
// bypassed by spraying attempts at different instances. Survives restarts.
const MAX_ATTEMPTS  = 5;
const LOCKOUT_MS    = 15 * 60 * 1000; // 15 minutes

async function checkLoginAttempts(email: string): Promise<void> {
  const row = await prisma.loginAttempt.findUnique({ where: { email } });
  if (row?.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
    const remaining = Math.ceil((row.lockedUntil.getTime() - Date.now()) / 60000);
    throw Object.assign(new Error(`Too many failed attempts. Try again in ${remaining} minute(s).`), { statusCode: 429, code: "RATE_LIMITED" });
  }
}

async function recordFailedLogin(email: string): Promise<void> {
  const row = await prisma.loginAttempt.upsert({
    where: { email },
    create: { email, count: 1 },
    update: { count: { increment: 1 } },
  });
  if (row.count >= MAX_ATTEMPTS) {
    await prisma.loginAttempt.update({
      where: { email },
      data: { lockedUntil: new Date(Date.now() + LOCKOUT_MS), count: 0 },
    });
  }
}

async function clearLoginAttempts(email: string): Promise<void> {
  await prisma.loginAttempt.deleteMany({ where: { email } });
}

/**
 * Request metadata captured by the controller. Threaded through every
 * auth path so RefreshToken rows preserve IP + UA — without this the
 * admin "active sessions" UI shows dashes and the anomaly detector
 * has no geo signal.
 */
export interface AuthMeta {
  ip?:        string | null
  userAgent?: string | null
  // "web" | "mobile" | "unknown" — captured at signup for product analytics.
  platform?:  string | null
}

/**
 * Enforce TOTP at login. No-op if the account has no enabled TOTP secret.
 * Otherwise requires a valid current TOTP code OR an unused backup code
 * (consumed on use). Throws a `TOTP_REQUIRED`/`TOTP_INVALID` coded error so the
 * client can prompt for the second factor.
 */
async function enforceTotp(userId: string, code: string | undefined): Promise<void> {
  const row = await prisma.totpSecret.findUnique({
    where: { userId },
    select: { secretBase32: true, enabled: true, backupCodes: true },
  });
  if (!row?.enabled) return; // 2FA not enabled for this account

  if (!code) throw unauth("Two-factor code required", "TOTP_REQUIRED");

  // Try a live TOTP code first.
  if (verifyTotp(row.secretBase32, code.replace(/\s/g, ""))) {
    await prisma.totpSecret.update({ where: { userId }, data: { lastUsedAt: new Date() } }).catch(() => {});
    return;
  }

  // Fall back to single-use backup codes (stored hashed).
  const codes = Array.isArray(row.backupCodes) ? (row.backupCodes as string[]) : [];
  const hashed = hashBackupCode(code.replace(/\s/g, "").toUpperCase());
  if (codes.includes(hashed)) {
    await prisma.totpSecret.update({
      where: { userId },
      data: { backupCodes: codes.filter((c) => c !== hashed), lastUsedAt: new Date() },
    }).catch(() => {});
    return;
  }

  throw unauth("Invalid two-factor code", "TOTP_INVALID");
}

export async function login(dto: LoginDto, meta: AuthMeta = {}) {
  // Brute-force guard: reject immediately if account is temporarily locked
  await checkLoginAttempts(dto.email);

  // Single query: fetch user with all needed fields + passwordHash
  const userWithHash = await prisma.user.findUnique({
    where: { email: dto.email },
    select: { ...userSelect, passwordHash: true },
  });

  if (!userWithHash) {
    await recordFailedLogin(dto.email);
    throw unauth("Invalid email or password");
  }

  const valid = await verifyPassword(userWithHash.passwordHash, dto.password);
  if (!valid) {
    await recordFailedLogin(dto.email);
    throw unauth("Invalid email or password");
  }

  // Second factor: if the account has TOTP enabled, a valid TOTP (or single-use
  // backup) code is required before any token is issued. Without this, 2FA was
  // enrollment-only and gave no actual login protection.
  await enforceTotp(userWithHash.id, dto.totpCode);

  // Successful login → clear failure counter
  await clearLoginAttempts(dto.email);

  // Strip the passwordHash before returning to callers
  const { passwordHash: _hash, ...user } = userWithHash;

  const accessToken = signAccessToken(user.id);
  const refreshToken = signRefreshToken(user.id);

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: {
      token:     refreshToken,
      userId:    user.id,
      expiresAt,
      ipAddress: meta.ip        ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    },
  });

  // Update streak on login (Duolingo model: login = activity = streak tick)
  void updateStreak(user.id).catch(() => {});

  return { user, accessToken, refreshToken };
}

// How long a just-rotated refresh token is still honoured, so concurrent/retried
// refreshes (two tabs, a reload while a request is in flight) don't trip
// reuse-detection and log the user out everywhere.
const REFRESH_GRACE_MS = 60_000;

function revokeFamily(userId: string) {
  return prisma.refreshToken.deleteMany({ where: { userId } }).catch(() => {});
}

export async function refresh(oldToken: string, meta: AuthMeta = {}) {
  // Validate JWT signature/expiry first
  const payload = verifyRefreshToken(oldToken);

  const storedToken = await prisma.refreshToken.findUnique({ where: { token: oldToken } });

  // Unknown token: signature is valid (we issued it) but no row — it was purged
  // long ago or never persisted. Treat as theft; revoke the family.
  if (!storedToken) {
    await revokeFamily(payload.userId);
    recordSecurityEvent("session_revoked", {
      userId: payload.userId, metadata: { reason: "refresh_token_reuse_detected" },
    });
    throw unauth("Session expired — please sign in again");
  }

  if (storedToken.expiresAt < new Date()) {
    await prisma.refreshToken.delete({ where: { token: oldToken } }).catch(() => {});
    throw unauth("Refresh token has expired");
  }

  // Already rotated once. Within the grace window this is a benign race (another
  // tab refreshed first) — hand back a fresh access token + the replacement
  // refresh token so this client converges, WITHOUT revoking anything. Past the
  // window it's genuine reuse → revoke the family.
  if (storedToken.rotatedAt) {
    const withinGrace = Date.now() - storedToken.rotatedAt.getTime() <= REFRESH_GRACE_MS;
    if (withinGrace && storedToken.replacedBy) {
      return { accessToken: signAccessToken(payload.userId), refreshToken: storedToken.replacedBy };
    }
    await revokeFamily(payload.userId);
    recordSecurityEvent("session_revoked", {
      userId: payload.userId, metadata: { reason: "refresh_token_reuse_detected" },
    });
    throw unauth("Session expired — please sign in again");
  }

  // Normal rotation: mark the old token rotated (kept for the grace window) and
  // issue a new one. Carry the current IP/UA so the session row reflects "now".
  const accessToken = signAccessToken(payload.userId);
  const newRefreshToken = signRefreshToken(payload.userId);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { token: oldToken },
      data: { rotatedAt: new Date(), replacedBy: newRefreshToken },
    }),
    prisma.refreshToken.create({
      data: {
        token:     newRefreshToken,
        userId:    payload.userId,
        expiresAt,
        ipAddress: meta.ip        ?? storedToken.ipAddress ?? null,
        userAgent: meta.userAgent?.slice(0, 500) ?? storedToken.userAgent ?? null,
      },
    }),
  ]);

  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout(userId: string, refreshToken: string): Promise<void> {
  await prisma.refreshToken.deleteMany({
    where: { token: refreshToken, userId },
  });
}

export async function logoutAll(userId: string): Promise<void> {
  await prisma.refreshToken.deleteMany({
    where: { userId },
  });
}

// ─── OAuth helpers ────────────────────────────────────────────────────────────

async function generateUniqueUsername(base: string, maxAttempts = 10): Promise<string> {
  const clean = base.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 20) || "user";
  for (let i = 0; i < maxAttempts; i++) {
    const suffix   = Math.floor(Math.random() * 90000 + 10000); // 5-digit suffix
    const candidate = `${clean}${suffix}`;
    const exists = await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } });
    if (!exists) return candidate;
  }
  // Fallback: timestamp-based suffix is always unique
  return `${clean}${Date.now().toString(36)}`;
}

async function findOrCreateOAuthUser(opts: {
  provider:    "google" | "apple";
  providerId:  string;
  email:       string;
  displayName: string;
  avatarUrl?:  string;
}) {
  // 1. Check if this provider account is already linked
  const existingProvider = await prisma.userOAuthProvider.findUnique({
    where: { provider_providerId: { provider: opts.provider, providerId: opts.providerId } },
    include: { user: { select: userSelect } },
  });
  if (existingProvider) return existingProvider.user;

  // 2. Check if a user already exists with this email (link the provider to them)
  let user = await prisma.user.findUnique({
    where:  { email: opts.email },
    select: userSelect,
  });

  // Refresh avatar from OAuth provider on every login
  if (user && opts.avatarUrl && user.avatarUrl !== opts.avatarUrl) {
    user = await prisma.user.update({
      where:  { id: user.id },
      data:   { avatarUrl: opts.avatarUrl },
      select: userSelect,
    });
  }

  if (!user) {
    // Invite-only gate: OAuth can't carry an invite code, so new OAuth signups
    // are blocked while the gate is on (existing users still log in fine).
    if (await getInviteOnly()) {
      throw forbidden("Kaiveron is invite-only right now — sign up with an invite code on the web first.");
    }
    // 3. Create a brand-new user
    const username = await generateUniqueUsername(opts.email.split("@")[0]);
    const slug     = await generateUniqueSlug(opts.displayName || username);
    user = await prisma.user.create({
      data: {
        email:        opts.email,
        username,
        displayName:  opts.displayName,
        slug,
        passwordHash: crypto.randomBytes(32).toString("hex"),
        avatarUrl:    opts.avatarUrl,
        // The OAuth provider (Google/Apple) already verified the email address.
        emailVerifiedAt: new Date(),
      },
      select: userSelect,
    });
    sendEmail(welcomeEmail(opts.email, opts.displayName)).catch(console.error);
  }

  // 4. Link this OAuth provider to the user
  await prisma.userOAuthProvider.create({
    data: { userId: user.id, provider: opts.provider, providerId: opts.providerId },
  });

  return user;
}

export async function googleLogin(dto: GoogleLoginDto, meta: AuthMeta = {}) {
  if (!env.GOOGLE_CLIENT_ID) throw unauth("Google OAuth is not configured");

  const ticket = await googleClient.verifyIdToken({
    idToken: dto.idToken,
    audience: env.GOOGLE_CLIENT_ID,
  }).catch(() => { throw unauth("Invalid Google ID token"); });

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) throw unauth("Incomplete Google token payload");
  if (!payload.email_verified) throw unauth("Google email is not verified");

  const user = await findOrCreateOAuthUser({
    provider:    "google",
    providerId:  payload.sub,
    email:       payload.email,
    displayName: payload.name || payload.email.split("@")[0],
    avatarUrl:   payload.picture,
  });

  return issueTokens(user, meta);
}

export async function appleLogin(dto: AppleLoginDto, meta: AuthMeta = {}) {
  if (!env.APPLE_CLIENT_ID) throw unauth("Apple Sign In is not configured");

  const payload = await appleSignin.verifyIdToken(dto.idToken, {
    audience:          env.APPLE_CLIENT_ID,
    ignoreExpiration:  false,
  }).catch(() => { throw unauth("Invalid Apple ID token"); });

  if (!payload.sub) throw unauth("Incomplete Apple token payload");

  // Apple only sends email on first sign-in; fall back to dto.email
  const email = payload.email || dto.email;
  if (!email) throw unauth("Email required for Apple Sign In (first login only)");

  const firstName = dto.firstName || "";
  const lastName  = dto.lastName  || "";
  const displayName = (firstName + " " + lastName).trim() || email.split("@")[0];

  const user = await findOrCreateOAuthUser({
    provider:   "apple",
    providerId: payload.sub,
    email,
    displayName,
  });

  return issueTokens(user, meta);
}

// ─── Redirect-based Google OAuth: exchange authorization code for tokens ─────

export async function googleCallbackCode(code: string, redirectUri: string, meta: AuthMeta = {}) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw unauth("Google OAuth is not configured");
  }

  // Exchange the auth code for Google tokens (redirectUri must exactly match what was sent in the auth request)
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  redirectUri,
      grant_type:    "authorization_code",
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error("[Google token exchange]", err);
    let code = "exchange_failed";
    try { code = (JSON.parse(err) as { error?: string }).error || code; } catch { /* not json */ }
    throw unauth(`google_token:${code}`);
  }

  const tokens = await tokenRes.json() as { id_token?: string; access_token?: string };

  if (!tokens.id_token) throw unauth("No ID token from Google");

  // Verify the ID token with google-auth-library
  const ticket = await googleClient.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.GOOGLE_CLIENT_ID,
  }).catch(() => { throw unauth("Invalid Google ID token"); });

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) throw unauth("Incomplete Google token payload");
  if (!payload.email_verified) throw unauth("Google email is not verified");

  const user = await findOrCreateOAuthUser({
    provider:    "google",
    providerId:  payload.sub,
    email:       payload.email,
    displayName: payload.name || payload.email.split("@")[0],
    avatarUrl:   payload.picture,
  });

  return issueTokens(user, meta);
}

// ─── changePassword ───────────────────────────────────────────────────────────

export async function changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!user) throw unauth("User not found");

  // Accounts created via OAuth may have no password — reject gracefully
  if (!user.passwordHash) {
    throw badRequest("Your account uses OAuth (Google/Apple). Set a password from Security Settings first.");
  }

  const valid = await verifyPassword(user.passwordHash, dto.currentPassword);
  if (!valid) throw badRequest("Current password is incorrect.");

  const newHash = await hashPassword(dto.newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: newHash } });
}

// ──────────────────────────────────────────────────────────────────────────────

async function issueTokens(user: { id: string; [k: string]: unknown }, meta: AuthMeta = {}) {
  const accessToken  = signAccessToken(user.id as string);
  const refreshToken = signRefreshToken(user.id as string);
  const expiresAt    = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: {
      token:     refreshToken,
      userId:    user.id as string,
      expiresAt,
      ipAddress: meta.ip        ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    },
  });
  return { user, accessToken, refreshToken };
}

// Used by the OAuth handoff endpoint to mint a fresh refresh token
// after Google sign-in. The token is set as a cookie by the controller.
export async function issueRefreshTokenForUser(userId: string, meta: AuthMeta = {}): Promise<string> {
  const refreshToken = signRefreshToken(userId);
  const expiresAt    = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: {
      token:     refreshToken,
      userId,
      expiresAt,
      ipAddress: meta.ip        ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    },
  });
  return refreshToken;
}

// ─── Password Reset ───────────────────────────────────────────────────────────

/**
 * Step 1: generate a reset token, store its hash, return the plaintext token.
 * The plaintext token is emailed to the user — only its SHA-256 hash is in the DB,
 * so even a DB read can't be used to reset a password.
 *
 * Returns null if the email isn't registered (caller should still pretend success
 * to avoid user enumeration attacks).
 */
export async function createPasswordResetToken(email: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return null;

  // Invalidate any prior unconsumed tokens for this user (only the latest works)
  await prisma.passwordResetToken.deleteMany({
    where: { userId: user.id, consumedAt: null },
  });

  const token     = crypto.randomBytes(32).toString("base64url"); // 256 bits, URL-safe
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 60 * 60_000);            // 1 hour

  await prisma.passwordResetToken.create({
    data: { tokenHash, userId: user.id, expiresAt },
  });

  return token;
}

/**
 * Step 2: consume a reset token, set the new password.
 * Throws on invalid, expired, or already-used tokens. Single-use enforced
 * via consumedAt timestamp + unique tokenHash.
 */
export async function consumePasswordResetToken(token: string, newPassword: string): Promise<{ userId: string }> {
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, expiresAt: true, consumedAt: true },
  });

  if (!stored)                            throw unauth("Invalid or expired reset token");
  if (stored.consumedAt)                  throw unauth("This reset link has already been used");
  if (stored.expiresAt < new Date())      throw unauth("This reset link has expired");

  const newHash = await hashPassword(newPassword);

  // Atomic: update password + mark token consumed + revoke ALL existing sessions
  await prisma.$transaction([
    prisma.user.update({ where: { id: stored.userId }, data: { passwordHash: newHash } }),
    prisma.passwordResetToken.update({ where: { id: stored.id }, data: { consumedAt: new Date() } }),
    prisma.refreshToken.deleteMany({ where: { userId: stored.userId } }),
  ]);

  return { userId: stored.userId };
}

// ─── Account Deletion (GDPR) ──────────────────────────────────────────────────

/**
 * Hard-delete the user account. Cascading deletes in the Prisma schema clean up
 * all owned data (posts, lists, refresh tokens, etc.). For OAuth-only accounts,
 * the password check is skipped (no password to verify against).
 */
export async function deleteAccount(userId: string, password?: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!user) throw unauth("User not found");

  // If the user has a password set, require it
  if (user.passwordHash) {
    if (!password) throw badRequest("Password confirmation required");
    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid)   throw badRequest("Password is incorrect");
  }

  // ClubOwner is the only relation with onDelete: Restrict — null it out first
  // so the cascade doesn't fail
  await prisma.club.updateMany({
    where: { ownerId: userId },
    data:  { ownerId: "deleted_user" },
  }).catch(() => {});

  await prisma.user.delete({ where: { id: userId } });

  // Note: cascading delete already removed the user row, so we record the
  // event AFTER the delete with userId=null + the original id in metadata.
  recordSecurityEvent("account_deleted", {
    userId: null,
    metadata: { deletedUserId: userId, hadPassword: !!user.passwordHash },
  });
}

// ─── Active Sessions ──────────────────────────────────────────────────────────

export async function listActiveSessions(userId: string, currentRefreshToken: string | undefined) {
  const sessions = await prisma.refreshToken.findMany({
    // Exclude rotated tokens — they're superseded and only kept for the grace window.
    where: { userId, expiresAt: { gt: new Date() }, rotatedAt: null },
    orderBy: { lastUsedAt: "desc" },
    select: {
      id: true,
      userAgent: true,
      ipAddress: true,
      lastUsedAt: true,
      createdAt: true,
      token: true,
    },
  });

  return sessions.map(s => ({
    id:        s.id,
    userAgent: s.userAgent ?? "Unknown device",
    ipAddress: s.ipAddress,
    lastUsedAt: s.lastUsedAt,
    createdAt: s.createdAt,
    isCurrent: !!currentRefreshToken && s.token === currentRefreshToken,
  }));
}

export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { id: sessionId, userId } });
}
