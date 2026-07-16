import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { rateLimit } from "../../middlewares/rateLimit.middleware";
import * as ctrl from "./waitlist.controller";

export const waitlistRouter = Router();

// Public join — rate limited to deter list-stuffing, but generous enough not to
// false-block legit users behind a shared IP (office/campus/mobile-carrier NAT)
// or someone testing the form. Joins are idempotent per email, so the only abuse
// vector is many DISTINCT fake emails; 20 / 10 min per IP caps that comfortably.
waitlistRouter.post("/", rateLimit(20, 10 * 60 * 1000), ctrl.join);

// CRON_SECRET-gated cohort send (must be declared before the "/" GET so the
// path is distinct). Prunes members, then emails the invite to the waitlist.
waitlistRouter.post("/send-invites", ctrl.sendInvites);

// Admin — list captured emails.
waitlistRouter.get("/", requireAuth, requireAdmin, ctrl.list);

// Admin — remove rows by email (prune test/junk/bot signups). Body: { emails[] }.
waitlistRouter.delete("/", requireAuth, requireAdmin, ctrl.remove);
