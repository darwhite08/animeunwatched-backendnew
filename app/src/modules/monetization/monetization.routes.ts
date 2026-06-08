import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./monetization.controller";

export const monetizationRouter = Router();

monetizationRouter.use(requireAuth);

monetizationRouter.get("/eligibility", ctrl.getEligibility);
monetizationRouter.get("/tiers",       ctrl.getTiers);
monetizationRouter.post("/tiers",      ctrl.postTier);
monetizationRouter.patch("/tiers/:id", ctrl.patchTier);
monetizationRouter.get("/revenue",     ctrl.getRevenue);
monetizationRouter.get("/payouts",     ctrl.getPayouts);
