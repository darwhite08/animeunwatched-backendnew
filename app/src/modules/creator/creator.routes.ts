import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./creator.controller";

export const creatorRouter = Router();

creatorRouter.use(requireAuth);

creatorRouter.get("/stats", ctrl.getCreatorStats);
creatorRouter.get("/content", ctrl.getContentPerformance);
