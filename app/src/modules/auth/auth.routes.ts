import { Router } from "express";
import * as ctrl from "./auth.controller";
import { requireAuth } from "../../middlewares/auth.middleware";

export const authRouter = Router();

authRouter.post("/register",   ctrl.register);
authRouter.post("/login",      ctrl.login);
authRouter.post("/refresh",    ctrl.refresh);
authRouter.post("/logout",     requireAuth, ctrl.logout);
authRouter.post("/logout-all", requireAuth, ctrl.logoutAll);
authRouter.get( "/me",         requireAuth, ctrl.me);

// OAuth — credential (One-Tap / popup, works on desktop)
authRouter.post("/google", ctrl.googleLogin);
authRouter.post("/apple",  ctrl.appleLogin);

// OAuth — redirect flow (works on ALL devices including mobile)
authRouter.get("/google/redirect",  ctrl.googleRedirect);
authRouter.get("/google/callback",  ctrl.googleCallback);
