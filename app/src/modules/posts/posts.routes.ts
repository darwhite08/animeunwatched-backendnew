import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./posts.controller";

export const postsRouter = Router();

// Specific named routes before dynamic /:id
postsRouter.get("/discover", optionalAuth, ctrl.getDiscover);
postsRouter.get("/feed", requireAuth, ctrl.getFeed);

// Threaded replies + comment likes (must be before /:id catch-all)
postsRouter.get("/comments/:commentId/replies", optionalAuth, ctrl.getCommentReplies);
postsRouter.post("/comments/:commentId/like", requireAuth, ctrl.likeComment);
postsRouter.delete("/comments/:commentId/like", requireAuth, ctrl.unlikeComment);

postsRouter.get("/:id", optionalAuth, ctrl.getPost);
postsRouter.post("/", requireAuth, ctrl.createPost);
postsRouter.delete("/:id", requireAuth, ctrl.deletePost);
postsRouter.post("/:id/like", requireAuth, ctrl.likePost);
postsRouter.delete("/:id/like", requireAuth, ctrl.unlikePost);
postsRouter.get("/:id/comments", optionalAuth, ctrl.getComments);
postsRouter.post("/:id/comments", requireAuth, ctrl.createComment);
