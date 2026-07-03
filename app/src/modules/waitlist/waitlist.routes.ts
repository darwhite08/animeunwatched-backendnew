import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { rateLimit } from "../../middlewares/rateLimit.middleware";
import * as ctrl from "./waitlist.controller";

export const waitlistRouter = Router();

// Public join — tight rate limit (5 / 10 min per IP) to deter list-stuffing.
waitlistRouter.post("/", rateLimit(5, 10 * 60 * 1000), ctrl.join);

// CRON_SECRET-gated cohort send (must be declared before the "/" GET so the
// path is distinct). Prunes members, then emails the invite to the waitlist.
waitlistRouter.post("/send-invites", ctrl.sendInvites);

// Admin — list captured emails.
waitlistRouter.get("/", requireAuth, requireAdmin, ctrl.list);
