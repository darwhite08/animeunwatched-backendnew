import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./social.controller";

export const socialRouter = Router();

// Public — config health check (boolean only) + provider OAuth redirect targets.
socialRouter.get("/health", ctrl.health);
socialRouter.get("/instagram/callback", ctrl.instagramCallback);
socialRouter.get("/tiktok/callback",    ctrl.tiktokCallback);

// Everything else is the authenticated creator managing their own connections.
socialRouter.get("/connections",          requireAuth, ctrl.getConnections);
socialRouter.get("/instagram/connect",    requireAuth, ctrl.startInstagram);
socialRouter.get("/instagram/reels",      requireAuth, ctrl.getReels);
socialRouter.post("/instagram/import",    requireAuth, ctrl.importReels);
socialRouter.delete("/instagram",         requireAuth, ctrl.disconnectInstagram);
socialRouter.get("/tiktok/connect",       requireAuth, ctrl.startTiktok);
socialRouter.get("/tiktok/videos",        requireAuth, ctrl.getTiktokVideos);
socialRouter.post("/tiktok/import",       requireAuth, ctrl.importTiktok);
socialRouter.delete("/tiktok",            requireAuth, ctrl.disconnectTiktok);
