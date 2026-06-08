import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import { turnstile } from "../../middlewares/turnstile.middleware";
import * as ctrl from "./shots.controller";

export const shotsRouter = Router();

// Specific named routes before dynamic /:id
shotsRouter.get("/feed", optionalAuth, ctrl.getFeed);
shotsRouter.get("/user/:userId", optionalAuth, ctrl.getUserShots);
// Comment delete uses a 2-segment path; declare before dynamic /:id routes
shotsRouter.delete("/comments/:commentId", requireAuth, ctrl.deleteComment);

// turnstile() is a no-op until TURNSTILE_SECRET is set
shotsRouter.post("/", requireAuth, turnstile(), ctrl.createShot);
shotsRouter.delete("/:id", requireAuth, ctrl.deleteShot);
shotsRouter.post("/:id/like", requireAuth, ctrl.likeShot);
shotsRouter.delete("/:id/like", requireAuth, ctrl.unlikeShot);

// Comments on a shot
shotsRouter.get("/:id/comments", optionalAuth, ctrl.listComments);
shotsRouter.post("/:id/comments", requireAuth, turnstile(), ctrl.createComment);
