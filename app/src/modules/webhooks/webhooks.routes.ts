import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireAdmin } from "../../middlewares/requireAdmin";
import * as ctrl from "./webhooks.controller";

export const webhooksRouter = Router();

// GET /webhooks/test — admin only: fires a test webhook and returns the payload
webhooksRouter.get("/test", requireAuth, requireAdmin, ctrl.testWebhook);

// POST /webhooks/cron/weekly-digest — called by Render cron job or external scheduler
// Protected by CRON_SECRET header to prevent unauthorized triggers
webhooksRouter.post("/cron/weekly-digest", ctrl.weeklyDigestCron);

// POST /webhooks/cron/streak-reminders — sends streak reminders to at-risk users
webhooksRouter.post("/cron/streak-reminders", ctrl.streakRemindersCron);

// POST /webhooks/media/shot-normalized — called by the media-normalization
// pipeline (finalize Lambda) after a clip is loudness-normalized. CRON_SECRET-
// protected. Body: { shotId, normalizedKey }. Swaps the shot to the normalized
// file + stamps normalizedAt so it isn't reprocessed.
webhooksRouter.post("/media/shot-normalized", ctrl.shotNormalized);
