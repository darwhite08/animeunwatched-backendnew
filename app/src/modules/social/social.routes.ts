import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./social.controller";

export const socialRouter = Router();

// Public — Instagram redirects the browser here (no auth header; state-verified).
socialRouter.get("/instagram/callback", ctrl.instagramCallback);

// Everything else is the authenticated creator managing their own connections.
socialRouter.get("/connections",          requireAuth, ctrl.getConnections);
socialRouter.get("/instagram/connect",    requireAuth, ctrl.startInstagram);
socialRouter.get("/instagram/reels",      requireAuth, ctrl.getReels);
socialRouter.post("/instagram/import",    requireAuth, ctrl.importReels);
socialRouter.delete("/instagram",         requireAuth, ctrl.disconnectInstagram);
