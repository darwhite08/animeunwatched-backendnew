import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./monetization.controller";

export const monetizationRouter = Router();

monetizationRouter.use(requireAuth);

monetizationRouter.get("/eligibility", ctrl.getEligibility);
monetizationRouter.get("/tiers",       ctrl.getTiers);
monetizationRouter.post("/tiers",      ctrl.postTier);
monetizationRouter.patch("/tiers/:id", ctrl.patchTier);
monetizationRouter.get("/revenue",        ctrl.getRevenue);
monetizationRouter.get("/revenue/series", ctrl.getRevenueSeries);
monetizationRouter.get("/retention",      ctrl.getRetention);
monetizationRouter.get("/members",        ctrl.getMembers);
monetizationRouter.get("/creator/:username", ctrl.getPublicCreator);  // fan-facing tiers + status
monetizationRouter.get("/payouts",        ctrl.getPayouts);

// Payments (Phase 2 — 503 "payments not configured" until Stripe keys are set)
monetizationRouter.post("/onboard",            ctrl.postOnboard);
monetizationRouter.post("/checkout/membership", ctrl.postCheckoutMembership);
monetizationRouter.post("/checkout/tip",        ctrl.postCheckoutTip);
