import { Router, raw } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./uploads.controller";

export const uploadsRouter = Router();

uploadsRouter.post("/avatar",     requireAuth, ctrl.avatar);
uploadsRouter.post("/post-image", requireAuth, ctrl.postImage);
uploadsRouter.post("/voice",      requireAuth, ctrl.voice);
uploadsRouter.post("/shot-video", requireAuth, ctrl.shotVideo);
uploadsRouter.post("/story",      requireAuth, ctrl.story);

// Server-side fallback when the browser can't PUT directly to S3.
// 10MB body cap matches the post-image limit in useImageUpload.
uploadsRouter.post(
  "/proxy",
  requireAuth,
  raw({ type: ["image/*"], limit: "10mb" }),
  ctrl.uploadProxy,
);
