import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./links.controller";

export const linksRouter = Router();

// Authenticated — creators unfurl links for blog previews.
linksRouter.get("/preview", requireAuth, ctrl.preview);
