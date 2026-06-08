import { Router } from "express";
import { optionalAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./config.controller";

export const configRouter = Router();

// Public client feature-flag map (optionalAuth → enables per-user rollout).
configRouter.get("/flags", optionalAuth, ctrl.getFlags);
