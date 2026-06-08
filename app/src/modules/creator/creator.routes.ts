import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./creator.controller";

export const creatorRouter = Router();

creatorRouter.use(requireAuth);

creatorRouter.get("/access",  ctrl.getAccess);   // can this user enter the Creator Studio?
creatorRouter.get("/stats",   ctrl.getCreatorStats);
creatorRouter.get("/content", ctrl.getContentPerformance);
creatorRouter.get("/daily",   ctrl.getDailySeries);

// Creator Studio analytics (real metrics aggregated from engagement data)
creatorRouter.get("/analytics/overview", ctrl.getAnalyticsOverview);
creatorRouter.get("/analytics/content",  ctrl.getAnalyticsContent);
creatorRouter.get("/analytics/audience", ctrl.getAnalyticsAudience);
