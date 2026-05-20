import { Request, Response, NextFunction } from "express";
import { env } from "../../config/env";
import { registerSchema, loginSchema, googleLoginSchema, appleLoginSchema, changePasswordSchema } from "./auth.schema";
import * as service from "./auth.service";

const COOKIE_OPTS = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/api/v1/auth",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = registerSchema.parse(req.body);
    const { user, accessToken, refreshToken } = await service.register(dto);
    res.cookie("aw_refresh", refreshToken, COOKIE_OPTS);
    res.status(201).json({ user, accessToken });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = loginSchema.parse(req.body);
    const { user, accessToken, refreshToken } = await service.login(dto);
    res.cookie("aw_refresh", refreshToken, COOKIE_OPTS);
    res.status(200).json({ user, accessToken });
  } catch (err) {
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
    const { accessToken, refreshToken } = await service.refresh(oldToken);
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
    res.clearCookie("aw_refresh", { path: COOKIE_OPTS.path });
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
    }
    res.clearCookie("aw_refresh", { path: COOKIE_OPTS.path });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export function me(req: Request, res: Response): void {
  res.status(200).json({ user: res.locals.user });
}

export async function changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user?.id;
    const dto = changePasswordSchema.parse(req.body);
    await service.changePassword(userId, dto);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function googleLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = googleLoginSchema.parse(req.body);
    const { user, accessToken, refreshToken } = await service.googleLogin(dto);
    res.cookie("aw_refresh", refreshToken, COOKIE_OPTS);
    res.status(200).json({ user, accessToken });
  } catch (err) {
    next(err);
  }
}

export async function appleLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const dto = appleLoginSchema.parse(req.body);
    const { user, accessToken, refreshToken } = await service.appleLogin(dto);
    res.cookie("aw_refresh", refreshToken, COOKIE_OPTS);
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

  try {
    // Validate CSRF state
    const stateParam  = req.query.state as string | undefined;
    const stateCookie = req.cookies?.aw_oauth_state as string | undefined;
    if (stateParam && stateCookie && stateParam !== stateCookie) {
      res.redirect(`${frontendUrl}/login?error=oauth_state_mismatch`);
      return;
    }
    res.clearCookie("aw_oauth_state");

    const code = req.query.code as string | undefined;
    if (!code) {
      res.redirect(`${frontendUrl}/login?error=google_no_code`);
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
    const { user, accessToken, refreshToken } = await service.googleCallbackCode(code, callbackUrl);

    // Set refresh cookie (httpOnly)
    res.cookie("aw_refresh", refreshToken, COOKIE_OPTS);

    // Redirect to frontend callback page with the access token in the URL.
    // The callback page reads it, stores in Zustand, then redirects to /dashboard.
    const qs = new URLSearchParams({
      access_token:  accessToken,
      display_name:  String(user.displayName ?? ""),
      avatar_url:    String(user.avatarUrl ?? ""),
    });
    res.redirect(`${frontendUrl}/auth/callback?${qs.toString()}`);
  } catch (err) {
    console.error("[Google callback]", err);
    res.redirect(`${frontendUrl}/login?error=google_failed`);
  }
}
