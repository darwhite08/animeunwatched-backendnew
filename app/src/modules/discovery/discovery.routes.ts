import { Router } from "express";
import { optionalAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./discovery.controller";

export const discoveryRouter = Router();

discoveryRouter.post("/ai",   optionalAuth, ctrl.ai);
discoveryRouter.post("/mood", optionalAuth, ctrl.mood);
discoveryRouter.post("/quiz", optionalAuth, ctrl.quiz);
