import { Router } from "express";
import { optionalAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./creator.controller";

// Public-facing creator storefront (no auth required; optionalAuth resolves the
// viewer for the isFollowing flag). Mounted at /storefront.
export const storefrontRouter = Router();

storefrontRouter.get("/:username", optionalAuth, ctrl.getStorefront);
