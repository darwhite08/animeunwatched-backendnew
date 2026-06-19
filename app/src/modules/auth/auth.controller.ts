import { Request, Response, NextFunction } from "express";
import { env } from "../../config/env";
import {
  registerSchema, loginSchema, googleLoginSchema, appleLoginSchema,
  changePasswordSchema, forgotPasswordSchema, resetPasswordSchema, deleteAccountSchema,
} from "./auth.schema";
import { sendEmail } from "../../lib/email";
import { recordSecurityEvent } from "../../lib/audit";
import * as service from "./auth.service";

/**
 * Extract the IP + User-Agent off an incoming request. Used to populate
 * RefreshToken.ipAddress + .userAgent so the admin "active sessions" list
 * shows where the user actually signed in from, and the anomaly detector
 * has geo data to work with. Reads X-Forwarded-For first (we sit behind
 * App Runner's ALB; trust proxy is set in app.ts).
 */
function authMeta(req: Request): { ip: string | null; userAgent: string | null; platform: string } {
  const xff = req.headers["x-forwarded-for"]
  const ip  = typeof xff === "string" ? xff.split(",")[0].trim() : (req.ip ?? null)
  const ua  = req.headers["user-agent"]
  return { ip: ip || null, userAgent: typeof ua === "string" ? ua : null, platform: detectPlatform(req) }
}

/**
 * Best-effort platform attribution for product analytics. The mobile app is a
 * Capacitor WebView served from app.kaiveron.com (and a Capacitor UA); the web
 * app is kaiveron.com. Clients may also send an explicit `X-Kaiveron-Platform`
 * header, which wins. Returns "web" | "mobile" | "unknown".
 */
function detectPlatform(req: Request): string {
  const explicit = req.headers["x-kaiveron-platform"]
  if (typeof explicit === "string") {
    const v = explicit.toLowerCase().trim()
    if (v === "web" || v === "mobile") return v
  }
  const origin = (typeof req.headers.origin === "string" ? req.headers.origin : "")
    || (typeof req.headers.referer === "string" ? req.headers.referer : "")
  const ua = (typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "").toLowerCase()
  if (/app\.kaiveron\.com/i.test(origin) || ua.includes("capacitor") || ua.includes("kaiveron-app")) return "mobile"
  if (/kaiveron\.com/i.test(origin)) return "web"
  return "unknown"
}

// Setting `domain: ".kaiveron.com"` makes the refresh cookie readable on
// every subdomain (kaiveron.com, www, api, admin-dashboard, etc.) so the
// admin subdomain can bootstrap a session from a kaiveron.com login.
// In non-production we omit the domain so localhost / vercel preview hosts
// still work without a hosts file hack.
const PROD_COOKIE_DOMAIN = env.NODE_ENV === "production" ? ".kaiveron.com" : undefined;

const COOKIE_OPTS = {
  httpOnly: true,
  secure:   env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path:     "/api/v1/auth",
  maxAge:   7 * 24 * 60 * 60 * 1000,
  ...(PROD_COOKIE_DOMAIN ? { domain: PROD_COOKIE_DOMAIN } : {}),
};

/**
 * Clear the refresh cookie in EVERY shape it might exist in the browser:
 *   1. The current shape (Domain=.kaiveron.com)
 *   2. The legacy shape from before that fix went out (no Domain, scoped
 *      to the exact request host)
 * Without (2), users who logged in pre-fix keep a stale duplicate cookie
 * that cookie-parser picks instead of the live one.
 */
function clearRefreshCookieEverywhere(res: Response): void {
  // 1) Domain-scoped (current)
  res.clearCookie("aw_refresh", {
    path:   COOKIE_OPTS.path,
    ...(PROD_COOKIE_DOMAIN ? { domain: PROD_COOKIE_DOMAIN } : {}),
  });
  // 2) Host-only legacy
  res.clearCookie("aw_refresh", { path: COOKIE_OPTS.path });
}

export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = registerSchema.parse(req.body);
    const { user, accessToken, refreshToken } = await service.register(dto, authMeta(req));
    res.cookie("aw_refresh", refreshToken, COOKIE_OPTS);
    recordSecurityEvent("register", { userId: (user as { id: string }).id, req });
    res.status(201).json({ user, accessToken });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = loginSchema.parse(req.body);
    const { user, accessToken, refreshToken } = await service.login(dto, authMeta(req));
    res.cookie("aw_refresh", refreshToken, COOKIE_OPTS);
    recordSecurityEvent("login_success", { userId: (user as { id: string }).id, req });
    res.status(200).json({ user, accessToken });
  } catch (err) {
    // Log failed login attempt for security audit (only if it's an auth error,
    // not a validation error)
    const body = req.body as { email?: unknown }
    if (body && typeof body.email === "string") {
      recordSecurityEvent("login_failed", { req, metadata: { email: body.email } });
    }
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const oldToken: string | undefined = req.cookies?.aw_refresh;
    if (!oldToken) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "No refresh token" } });
      return;
    }
    const { accessToken, refreshToken } = await service.refresh(oldToken, authMeta(req));
    res.cookie("aw_refresh", refreshToken, COOKIE_OPTS);
    res.status(200).json({ accessToken });
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const refreshToken: string | undefined = req.cookies?.aw_refresh;
    const userId: string = res.locals.user?.id;
    if (refreshToken && userId) {
      await service.logout(userId, refreshToken);
    }
    clearRefreshCookieEverywhere(res);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function logoutAll(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user?.id;
    if (userId) {
      await service.logoutAll(userId);
      recordSecurityEvent("logout_all", { userId, req });
    }
    clearRefreshCookieEverywhere(res);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export function me(req: Request, res: Response): void {
  res.status(200).json({ user: res.locals.user });
}

// Confirm the signup email-verification code. Requires a valid access token
// (the user is logged in but unverified). On success returns the updated user.
export async function verifyEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user?.id;
    const raw = (req.body as { code?: unknown })?.code;
    const code = typeof raw === "string" ? raw.trim() : "";
    if (!/^\d{6}$/.test(code)) {
      res.status(400).json({ error: { code: "VALIDATION", message: "Enter the 6-digit code from your email." } });
      return;
    }
    const { user } = await service.verifyEmail(userId, code);
    recordSecurityEvent("email_verified", { userId, req });
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
}

// Re-send the signup verification code (rate-limited in the service).
export async function resendVerification(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user?.id;
    const result = await service.resendVerification(userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * OAuth session handoff endpoint.
 *
 * Used after Google OAuth callback to ensure the refresh cookie is set on the
 * SAME domain that the frontend uses for all other API calls. Solves a CORS-style
 * problem: when Google's callback goes directly to the backend host, the
 * Set-Cookie lands on api.kaiveron.com, which is a different domain from
 * animeunwatched-frontend-delta.vercel.app — so future /auth/refresh calls
 * (proxied through Vercel) don't send the cookie.
 *
 * Flow:
 *  1. Google → backend OAuth callback (URL registered with Google) → sets short access token in URL
 *  2. Frontend /auth/callback receives access_token, stores in Zustand
 *  3. Frontend calls POST /auth/oauth-handoff THROUGH the Vercel proxy
 *  4. This handler issues a fresh refresh token + sets the cookie
 *  5. The Set-Cookie response goes through Vercel → browser stores it on the Vercel domain
 *  6. Future /auth/refresh calls (also through Vercel) now include the cookie
 */
export async function oauthHandoff(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user?.id;
    if (!userId) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Access token required" } });
      return;
    }
    const refreshToken = await service.issueRefreshTokenForUser(userId, authMeta(req));
    res.cookie("aw_refresh", refreshToken, COOKIE_OPTS);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// No authentication required.
// Clears the refresh cookie so the user can log in again even if the
// JWT secret was rotated and their httpOnly cookie is permanently invalid.
export function clearSession(req: Request, res: Response): void {
  clearRefreshCookieEverywhere(res)
  // Redirect to frontend login page after clearing the cookie
  const frontendUrl = process.env.FRONTEND_URL ?? "https://kaiveron.com"
  res.redirect(`${frontendUrl}/login`)
}

export async function changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user?.id;
    const dto = changePasswordSchema.parse(req.body);
    await service.changePassword(userId, dto);
    recordSecurityEvent("password_changed", { userId, req });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function googleLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = googleLoginSchema.parse(req.body);
    const { user, accessToken, refreshToken } = await service.googleLogin(dto, authMeta(req));
    res.cookie("aw_refresh", refreshToken, COOKIE_OPTS);
    recordSecurityEvent("oauth_login", { userId: (user as { id: string }).id, req, metadata: { provider: "google" } });
    res.status(200).json({ user, accessToken });
  } catch (err) {
    next(err);
  }
}

export async function appleLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = appleLoginSchema.parse(req.body);
    const { user, accessToken, refreshToken } = await service.appleLogin(dto, authMeta(req));
    res.cookie("aw_refresh", refreshToken, COOKIE_OPTS);
    recordSecurityEvent("oauth_login", { userId: (user as { id: string }).id, req, metadata: { provider: "apple" } });
    res.status(200).json({ user, accessToken });
  } catch (err) {
    next(err);
  }
}

// ─── Redirect-based Google OAuth (works on mobile + all browsers) ─────────────

/** Step 1 — redirect the browser to Google's consent screen */
export function googleRedirect(req: Request, res: Response): void {
  if (!env.GOOGLE_CLIENT_ID) {
    res.status(503).send("Google OAuth not configured");
    return;
  }

  // Derive the public base URL: explicit env var → Render auto-var → request host → localhost
  const base =
    env.OAUTH_CALLBACK_BASE ||
    process.env.RENDER_EXTERNAL_URL ||
    (env.NODE_ENV === "production"
      ? `${req.protocol}://${req.get("host")}`
      : `http://localhost:${env.PORT}`);
  const callbackUrl = `${base}/api/v1/auth/google/callback`;

  // Generate a CSRF state token and store it in a short-lived cookie
  const state = require("crypto").randomBytes(16).toString("hex");
  res.cookie("aw_oauth_state", state, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60 * 1000, // 10 minutes
  });

  // Native (Capacitor) app flow: opened in the system browser with ?native=1.
  // Remember it so the callback deep-links the result back into the app
  // (kaiveron://) instead of redirecting to the web frontend.
  if (req.query.native === "1") {
    res.cookie("aw_oauth_native", "1", {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 10 * 60 * 1000,
    });
  }

  // Carry invite code / referral through the OAuth round-trip (short-lived
  // cookies, like the CSRF state above) so Google signup works under invite-only.
  const cookieOpts = { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "lax" as const, maxAge: 10 * 60 * 1000 };
  const inv = typeof req.query.invite === "string" ? req.query.invite.slice(0, 40) : "";
  const ref = typeof req.query.ref === "string" ? req.query.ref.slice(0, 30) : "";
  if (inv) res.cookie("aw_oauth_invite", inv, cookieOpts);
  if (ref) res.cookie("aw_oauth_ref", ref, cookieOpts);
  // mode=login → this is a sign-IN; the callback must NOT create a new account.
  if (req.query.mode === "login") res.cookie("aw_oauth_mode", "login", cookieOpts);

  const params = new URLSearchParams({
    client_id:     env.GOOGLE_CLIENT_ID,
    redirect_uri:  callbackUrl,
    response_type: "code",
    scope:         "openid email profile",
    access_type:   "online",
    prompt:        "select_account",
    state,
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

/** Step 2 — Google calls us back with ?code=… */
export async function googleCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
  const frontendUrl = env.FRONTEND_URL || "http://localhost:3000";

  // Native (Capacitor) app: send the result to the app's custom URL scheme so
  // the in-app browser hands control back to the app. Web stays on the site.
  const isNative = req.cookies?.aw_oauth_native === "1";
  if (isNative) res.clearCookie("aw_oauth_native");
  // Where errors go: a deep link for native, the web login page otherwise.
  const errorDest = (code: string) =>
    isNative ? `kaiveron://auth/callback?error=${code}` : `${frontendUrl}/login?error=${code}`;

  try {
    // Validate CSRF state
    const stateParam  = req.query.state as string | undefined;
    const stateCookie = req.cookies?.aw_oauth_state as string | undefined;
    if (stateParam && stateCookie && stateParam !== stateCookie) {
      res.redirect(errorDest("oauth_state_mismatch"));
      return;
    }
    res.clearCookie("aw_oauth_state");

    const code = req.query.code as string | undefined;
    if (!code) {
      res.redirect(errorDest("google_no_code"));
      return;
    }

    // Use the same base URL as step 1 to guarantee redirect_uri matches exactly
    const base =
      env.OAUTH_CALLBACK_BASE ||
      process.env.RENDER_EXTERNAL_URL ||
      (env.NODE_ENV === "production"
        ? `https://${req.get("host")}`      // force https in prod (Render terminates SSL)
        : `http://localhost:${env.PORT}`);
    const callbackUrl = `${base}/api/v1/auth/google/callback`;
    // Invite/referral stashed by googleRedirect — lets Google pass invite-only.
    const inviteCode = req.cookies?.aw_oauth_invite as string | undefined;
    const referredBy = req.cookies?.aw_oauth_ref as string | undefined;
    const mode       = req.cookies?.aw_oauth_mode as string | undefined;
    if (inviteCode) res.clearCookie("aw_oauth_invite");
    if (referredBy) res.clearCookie("aw_oauth_ref");
    if (mode) res.clearCookie("aw_oauth_mode");
    const { user, accessToken, refreshToken } = await service.googleCallbackCode(code, callbackUrl, authMeta(req), { inviteCode, referredBy, allowCreate: mode !== "login" });
    recordSecurityEvent("oauth_login", { userId: (user as { id: string }).id, req, metadata: { provider: "google", flow: "redirect" } });

    // Set refresh cookie (httpOnly)
    res.cookie("aw_refresh", refreshToken, COOKIE_OPTS);

    // Hand the access token to the callback page via the URL. The web callback
    // page (also reached by the native app via deep link → in-app navigation)
    // stores it, then calls /auth/oauth-handoff to land the refresh cookie on
    // the right domain. For native, kaiveron://auth/callback opens the app,
    // whose deep-link handler routes the WebView to /auth/callback?<same qs>.
    const qs = new URLSearchParams({
      access_token:  accessToken,
      display_name:  String(user.displayName ?? ""),
      avatar_url:    String(user.avatarUrl ?? ""),
    });
    res.redirect(
      isNative
        ? `kaiveron://auth/callback?${qs.toString()}`
        : `${frontendUrl}/auth/callback?${qs.toString()}`,
    );
  } catch (err) {
    console.error("[Google callback]", err);
    // Unknown user tried to sign IN → send them to the login page with a clear,
    // dedicated error so the UI can nudge them to sign up / join the waitlist.
    if ((err as { code?: string })?.code === "NO_ACCOUNT") {
      res.redirect(errorDest("no_account"));
      return;
    }
    const reason = err instanceof Error ? err.message.slice(0, 100) : "unknown";
    const dest = errorDest("google_failed");
    res.redirect(`${dest}${dest.includes("?") ? "&" : "?"}reason=${encodeURIComponent(reason)}`);
  }
}

// ─── Password Reset ───────────────────────────────────────────────────────────

/**
 * Request a password reset email. Always returns 204 — even when the email
 * isn't registered — to prevent attackers from enumerating which emails
 * have accounts.
 */
export async function forgotPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = forgotPasswordSchema.parse(req.body);
    const token = await service.createPasswordResetToken(dto.email);

    if (token) {
      const frontendUrl = env.FRONTEND_URL || "http://localhost:3000";
      const resetUrl    = `${frontendUrl}/reset-password?token=${encodeURIComponent(token)}`;

      // Fire-and-forget email send; never block the response on email delivery
      void sendEmail({
        to:      dto.email,
        subject: "Reset your Kaiveron password",
        html: `
          <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:20px;overflow:hidden;border:1px solid #1a1a1a">
            <div style="background:linear-gradient(135deg,#0f0f0f,#1a1100);padding:24px 32px;border-bottom:1px solid #1a1a1a">
              <span style="font-size:20px;font-weight:900;font-style:italic;letter-spacing:-0.05em;color:#f59e0b">Kaiveron</span>
            </div>
            <div style="padding:32px">
              <h1 style="color:#fff;font-size:22px;margin:0 0 12px">Reset your password</h1>
              <p style="color:#aaa;line-height:1.7;margin-bottom:20px">
                Someone (hopefully you) requested a password reset for your Kaiveron account.
                The link below expires in <strong>1 hour</strong> and can only be used once.
              </p>
              <a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#fbbf24,#f59e0b);color:#000;text-decoration:none;border-radius:10px;font-weight:900;font-size:12px;letter-spacing:0.08em;text-transform:uppercase">Reset Password</a>
              <p style="color:#555;font-size:11px;margin-top:24px">If you didn't request this, ignore this email — your password stays unchanged.</p>
            </div>
          </div>
        `,
      })

      recordSecurityEvent("password_reset_requested", {
        req,
        metadata: { email: dto.email },
      });
    }

    // Always 204 — don't leak existence of the email
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

/** Consume a reset token and update the password. */
export async function resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = resetPasswordSchema.parse(req.body);
    const { userId } = await service.consumePasswordResetToken(dto.token, dto.newPassword);

    recordSecurityEvent("password_reset_completed", { userId, req });

    // Force re-login on the device that performed the reset
    clearRefreshCookieEverywhere(res);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// ─── Account Deletion ─────────────────────────────────────────────────────────

export async function deleteAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = res.locals.user?.id as string;
    const dto    = deleteAccountSchema.parse(req.body);
    await service.deleteAccount(userId, dto.password);

    recordSecurityEvent("account_deleted", { userId, req });

    clearRefreshCookieEverywhere(res);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// ─── Active Sessions ──────────────────────────────────────────────────────────

export async function listSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId       = res.locals.user?.id as string;
    const refreshToken = req.cookies?.aw_refresh as string | undefined;
    const sessions     = await service.listActiveSessions(userId, refreshToken);
    res.status(200).json({ sessions });
  } catch (err) {
    next(err);
  }
}

export async function revokeSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId    = res.locals.user?.id as string;
    const sessionId = req.params.sessionId as string;
    await service.revokeSession(userId, sessionId);

    recordSecurityEvent("session_revoked", { userId, req, metadata: { sessionId } });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
