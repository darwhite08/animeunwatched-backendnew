import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import { turnstile } from "../../middlewares/turnstile.middleware";
import * as ctrl from "./shots.controller";

export const shotsRouter = Router();

// Specific named routes before dynamic /:id
shotsRouter.get("/feed", optionalAuth, ctrl.getFeed);
shotsRouter.get("/user/:userId", optionalAuth, ctrl.getUserShots);

// turnstile() is a no-op until TURNSTILE_SECRET is set
shotsRouter.post("/", requireAuth, turnstile(), ctrl.createShot);
shotsRouter.delete("/:id", requireAuth, ctrl.deleteShot);
shotsRouter.post("/:id/like", requireAuth, ctrl.likeShot);
shotsRouter.delete("/:id/like", requireAuth, ctrl.unlikeShot);
