import { Router } from "express";
import * as ctrl from "./auth.controller";
import { requireAuth } from "../../middlewares/auth.middleware";

export const authRouter = Router();

authRouter.post("/register",   ctrl.register);
authRouter.post("/login",      ctrl.login);
authRouter.post("/refresh",    ctrl.refresh);
// Logout only needs the cookie (no Bearer token required) so it works
// even when the access token has expired or was never in memory
authRouter.post("/logout",           ctrl.logout);
authRouter.post("/logout-all",       requireAuth, ctrl.logoutAll);
authRouter.post("/change-password",  requireAuth, ctrl.changePassword);
authRouter.get( "/me",               requireAuth, ctrl.me);
// No auth needed — clears stale refresh cookie so users can log in again
// even if the JWT secret was rotated and their cookie is permanently invalid
authRouter.get( "/clear-session",    ctrl.clearSession);

// Issues a new refresh cookie on the request's response domain.
// Used after Google OAuth callback to ensure the cookie lands on the
// Vercel frontend domain (not the Render backend domain) so future
// refresh calls can find it. Requires a valid Bearer access token.
authRouter.post("/oauth-handoff",    requireAuth, ctrl.oauthHandoff);

// Password reset flow — both endpoints are unauthenticated (user is locked out)
// but app.ts already rate-limits /auth/* to prevent abuse
authRouter.post("/forgot-password",  ctrl.forgotPassword);
authRouter.post("/reset-password",   ctrl.resetPassword);

// GDPR account deletion — requires Bearer token + password confirmation
authRouter.post("/delete-account",   requireAuth, ctrl.deleteAccount);

// Active sessions for the security settings page
authRouter.get( "/sessions",                  requireAuth, ctrl.listSessions);
authRouter.delete("/sessions/:sessionId",     requireAuth, ctrl.revokeSession);

// OAuth — credential (One-Tap / popup, works on desktop)
authRouter.post("/google", ctrl.googleLogin);
authRouter.post("/apple",  ctrl.appleLogin);

// OAuth — redirect flow (works on ALL devices including mobile)
authRouter.get("/google/redirect",  ctrl.googleRedirect);
authRouter.get("/google/callback",  ctrl.googleCallback);
