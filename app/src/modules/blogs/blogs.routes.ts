import { Router } from "express";
import { requireAuth, optionalAuth, requireCreator } from "../../middlewares/auth.middleware";
import * as ctrl from "./blogs.controller";

export const blogsRouter = Router();

blogsRouter.get("/", optionalAuth, ctrl.list);
// Blogs are creator-authored — regular members cannot publish.
blogsRouter.post("/", requireAuth, requireCreator, ctrl.createBlog);
blogsRouter.get("/:slug", optionalAuth, ctrl.getBySlug);
blogsRouter.post("/:slug/view", optionalAuth, ctrl.recordView);
blogsRouter.patch("/:slug", requireAuth, ctrl.updateBlog);
blogsRouter.delete("/:slug", requireAuth, ctrl.deleteBlog);
blogsRouter.get("/:slug/comments",  optionalAuth, ctrl.getComments);
blogsRouter.post("/:slug/comments", requireAuth,  ctrl.createComment);
