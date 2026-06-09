import argon2 from "argon2";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import appleSignin from "apple-signin-auth";
import { generateUniqueSlug } from "../../lib/slug";
import { updateStreak } from "../../lib/streak";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { conflict, unauth, badRequest } from "../../lib/errors";
import { createNotification, NotificationType } from "../../lib/notify";
import { sendEmail, welcomeEmail } from "../../lib/email";
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
  username: true,
  slug: true,         // routing alias — never used for data access
  displayName: true,
  bio: true,
  avatarUrl: true,
  role: true,
  reputation: true,
  verifiedKind: true,
  onboardedAt: true,
  streakDays: true,   // real streak tracking (not rep-estimate)
  bestStreak: true,
  lastActiveAt: true,
  createdAt: true,
} as const;

// ---------- service methods ----------

export async function register(dto: RegisterDto, meta: AuthMeta = {}) {
  const [existingEmail, existingUsername] = await Promise.all([
    prisma.user.findUnique({ where: { email: dto.email } }),
    prisma.user.findUnique({ where: { username: dto.username } }),
  ]);

  if (existingEmail) throw conflict("Email is already in use");
  if (existingUsername) throw conflict("Username is already taken");

  const passwordHash = await hashPassword(dto.password);
  // Generate a human-readable slug from displayName. Unique, never exposes userId.
  const slug = await generateUniqueSlug(dto.displayName || dto.username);

  const user = await prisma.user.create({
    data: {
      email: dto.email,
      username: dto.username,
      displayName: dto.displayName,
      slug,
      passwordHash,
    },
    select: userSelect,
  });

  // Realtime signal to the admin dashboard (no-op if Socket.io isn't up yet).
  broadcastAdminUserSignup(user);

  sendEmail(welcomeEmail(dto.email, dto.displayName)).catch(console.error);

  // Reward referrer if referredBy username is provided
  if (dto.referredBy) {
    void (async () => {
      try {
        const referrer = await prisma.user.findUnique({ where: { username: dto.referredBy! } });
        if (referrer) {
          await prisma.user.update({ where: { id: referrer.id }, data: { reputation: { increment: 100 } } });
          await createNotification({
            recipientId: referrer.id,
            type: NotificationType.ACHIEVEMENT,
            payload: {
              message: `${dto.username} joined Kaiveron using your invite! +100 Rep for you.`,
              link: `/u/${dto.username}`,
            },
          });
        }
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

// ─── Brute-force lockout (in-memory, per email) ───────────────────────────────
// Resets on restart — acceptable for MVP. Use Redis for multi-instance production.
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();
const MAX_ATTEMPTS  = 5;
const LOCKOUT_MS    = 15 * 60 * 1000; // 15 minutes

function checkLoginAttempts(email: string): void {
  const entry = loginAttempts.get(email);
  if (!entry) return;
  if (entry.lockedUntil > Date.now()) {
    const remaining = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
    throw Object.assign(new Error(`Too many failed attempts. Try again in ${remaining} minute(s).`), { statusCode: 429, code: "RATE_LIMITED" });
  }
}

function recordFailedLogin(email: string): void {
  const entry = loginAttempts.get(email) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  loginAttempts.set(email, entry);
}

function clearLoginAttempts(email: string): void {
  loginAttempts.delete(email);
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
}

export async function login(dto: LoginDto, meta: AuthMeta = {}) {
  // Brute-force guard: reject immediately if account is temporarily locked
  checkLoginAttempts(dto.email);

  // Single query: fetch user with all needed fields + passwordHash
  const userWithHash = await prisma.user.findUnique({
    where: { email: dto.email },
    select: { ...userSelect, passwordHash: true },
  });

  if (!userWithHash) {
    recordFailedLogin(dto.email);
    throw unauth("Invalid email or password");
  }

  const valid = await verifyPassword(userWithHash.passwordHash, dto.password);
  if (!valid) {
    recordFailedLogin(dto.email);
    throw unauth("Invalid email or password");
  }

  // Successful login → clear failure counter
  clearLoginAttempts(dto.email);

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

export async function refresh(oldToken: string, meta: AuthMeta = {}) {
  // Validate JWT signature/expiry first
  const payload = verifyRefreshToken(oldToken);

  // Look up the stored token
  const storedToken = await prisma.refreshToken.findUnique({
    where: { token: oldToken },
  });

  if (!storedToken) throw unauth("Refresh token not found");
  if (storedToken.expiresAt < new Date()) {
    // Clean up expired token
    await prisma.refreshToken.delete({ where: { token: oldToken } });
    throw unauth("Refresh token has expired");
  }

  // Rotate: delete old, issue new — carry through current request's IP+UA
  // so the session row reflects where the user actually IS now, not where
  // they originally signed in.
  await prisma.refreshToken.delete({ where: { token: oldToken } });

  const accessToken = signAccessToken(payload.userId);
  const newRefreshToken = signRefreshToken(payload.userId);

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: {
      token:     newRefreshToken,
      userId:    payload.userId,
      expiresAt,
      ipAddress: meta.ip        ?? storedToken.ipAddress ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? storedToken.userAgent ?? null,
    },
  });

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
    throw unauth("Failed to exchange Google authorization code");
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
    where: { userId, expiresAt: { gt: new Date() } },
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
