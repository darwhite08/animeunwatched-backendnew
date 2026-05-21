import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./blogs.controller";

export const blogsRouter = Router();

blogsRouter.get("/", optionalAuth, ctrl.list);
blogsRouter.post("/", requireAuth, ctrl.createBlog);
blogsRouter.get("/:slug", optionalAuth, ctrl.getBySlug);
blogsRouter.patch("/:slug", requireAuth, ctrl.updateBlog);
blogsRouter.delete("/:slug", requireAuth, ctrl.deleteBlog);
blogsRouter.get("/:slug/comments",  optionalAuth, ctrl.getComments);
blogsRouter.post("/:slug/comments", requireAuth,  ctrl.createComment);
