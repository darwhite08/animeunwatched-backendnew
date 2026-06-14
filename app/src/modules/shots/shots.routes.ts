import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import { turnstile } from "../../middlewares/turnstile.middleware";
import * as ctrl from "./shots.controller";

export const shotsRouter = Router();

// Specific named routes before dynamic /:id
shotsRouter.get("/feed", optionalAuth, ctrl.getFeed);
shotsRouter.get("/saved", requireAuth, ctrl.getSaved);
shotsRouter.get("/user/:userId", optionalAuth, ctrl.getUserShots);
// Comment delete/like/pin use 2-segment paths; declare before dynamic /:id routes
shotsRouter.delete("/comments/:commentId", requireAuth, ctrl.deleteComment);
shotsRouter.post("/comments/:commentId/like", requireAuth, ctrl.likeComment);
shotsRouter.delete("/comments/:commentId/like", requireAuth, ctrl.unlikeComment);
shotsRouter.post("/comments/:commentId/pin", requireAuth, ctrl.pinComment);

// turnstile() is a no-op until TURNSTILE_SECRET is set
shotsRouter.post("/", requireAuth, turnstile(), ctrl.createShot);
shotsRouter.delete("/:id", requireAuth, ctrl.deleteShot);
shotsRouter.post("/:id/like", requireAuth, ctrl.likeShot);
shotsRouter.delete("/:id/like", requireAuth, ctrl.unlikeShot);
shotsRouter.post("/:id/save", requireAuth, ctrl.saveShot);
shotsRouter.delete("/:id/save", requireAuth, ctrl.unsaveShot);

// Comments on a shot
shotsRouter.get("/:id/comments", optionalAuth, ctrl.listComments);
shotsRouter.post("/:id/comments", requireAuth, turnstile(), ctrl.createComment);
