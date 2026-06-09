import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { rateLimit } from "../../middlewares/rateLimit.middleware";
import * as ctrl from "./ai.controller";

export const aiRouter = Router();

aiRouter.post("/ask", requireAuth, ctrl.ask);
aiRouter.post("/write", requireAuth, ctrl.write);
// Public — readers translate blogs/captions on the fly (rate-limited by IP).
aiRouter.post("/translate", rateLimit(60, 60_000, { bucket: "ai-translate" }), ctrl.translate);
