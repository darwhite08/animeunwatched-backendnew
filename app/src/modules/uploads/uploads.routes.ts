import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./uploads.controller";

export const uploadsRouter = Router();

uploadsRouter.post("/avatar", requireAuth, ctrl.avatar);
uploadsRouter.post("/post-image", requireAuth, ctrl.postImage);
uploadsRouter.post("/voice", requireAuth, ctrl.voice);
