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

// OAuth — credential (One-Tap / popup, works on desktop)
authRouter.post("/google", ctrl.googleLogin);
authRouter.post("/apple",  ctrl.appleLogin);

// OAuth — redirect flow (works on ALL devices including mobile)
authRouter.get("/google/redirect",  ctrl.googleRedirect);
authRouter.get("/google/callback",  ctrl.googleCallback);
