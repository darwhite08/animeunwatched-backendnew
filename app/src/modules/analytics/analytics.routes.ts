import { Router } from "express";
import { optionalAuth } from "../../middlewares/auth.middleware";
import { rateLimit } from "../../middlewares/rateLimit.middleware";
import * as ctrl from "./analytics.controller";

export const analyticsRouter = Router();

// Public analytics (rate-limited to prevent scraping)
analyticsRouter.use(rateLimit(60, 60_000));

analyticsRouter.get("/stats",       optionalAuth, ctrl.platformStats);
analyticsRouter.get("/top-anime",   optionalAuth, ctrl.topAnime);
analyticsRouter.get("/activity",    optionalAuth, ctrl.recentActivity);
analyticsRouter.get("/leaderboard", optionalAuth, ctrl.reputationLeaderboard);

// Realtime visitor tracking — feeds the admin dashboard's "right now" tile
analyticsRouter.post("/pageview", optionalAuth, ctrl.pageview);
