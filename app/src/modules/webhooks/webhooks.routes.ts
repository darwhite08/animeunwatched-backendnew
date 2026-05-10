import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireAdmin } from "../../middlewares/requireAdmin";
import * as ctrl from "./webhooks.controller";

export const webhooksRouter = Router();

// GET /webhooks/test — admin only: fires a test webhook and returns the payload
webhooksRouter.get("/test", requireAuth, requireAdmin, ctrl.testWebhook);
