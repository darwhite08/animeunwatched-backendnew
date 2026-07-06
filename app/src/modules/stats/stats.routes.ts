import { Router } from "express";
import * as ctrl from "./stats.controller";

export const statsRouter = Router();

// CRON_SECRET-gated ops stats.
statsRouter.get("/platforms", ctrl.platforms);
