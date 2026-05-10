import { Router } from "express";
import * as ctrl from "./analytics.controller";

export const analyticsRouter = Router();

analyticsRouter.get("/stats", ctrl.platformStats);
analyticsRouter.get("/top-anime", ctrl.topAnime);
analyticsRouter.get("/activity", ctrl.recentActivity);
