import { Router } from "express";
import { optionalAuth, requireAuth } from "../../middlewares/auth.middleware";
import { requireAdmin } from "../../middlewares/requireAdmin";
import * as ctrl from "./config.controller";

export const configRouter = Router();

// Public client feature-flag map (optionalAuth → enables per-user rollout).
configRouter.get("/flags", optionalAuth, ctrl.getFlags);
// Public signup config — whether the invite-only gate is active.
configRouter.get("/signup", ctrl.getSignupConfig);
// Admin: list raw client flags + toggle on/off (simple requireAdmin path)
configRouter.get("/flags/admin", requireAuth, requireAdmin, ctrl.listFlagsAdmin);
configRouter.patch("/flags/:key", requireAuth, requireAdmin, ctrl.setFlag);
