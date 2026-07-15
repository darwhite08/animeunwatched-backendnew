import { Router } from "express";
import { requireAuth, requireCreator } from "../../middlewares/auth.middleware";
import { rateLimit } from "../../middlewares/rateLimit.middleware";
import * as ctrl from "./integrations.controller";

export const integrationsRouter = Router();

// ── Inbound draft intake ──────────────────────────────────────────────────
// Public route (auth is the Bearer API key, verified in the service by hash).
// IP rate-limited so a leaked/abused key can't flood the review queue.
integrationsRouter.post(
  "/blog-drafts",
  rateLimit(60, 60_000, { bucket: "integration-intake" }),
  ctrl.submitDraft,
);

// ── Key management ────────────────────────────────────────────────────────
// Session-authed, same gate as blog authoring (creators only).
integrationsRouter.post("/keys", requireAuth, requireCreator, ctrl.createKey);
integrationsRouter.get("/keys", requireAuth, requireCreator, ctrl.listKeys);
integrationsRouter.delete("/keys/:id", requireAuth, requireCreator, ctrl.revokeKey);
integrationsRouter.post("/keys/:id/test", requireAuth, requireCreator, ctrl.testKey);
