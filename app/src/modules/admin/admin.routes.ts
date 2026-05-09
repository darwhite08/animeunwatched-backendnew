import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireAdmin } from "../../middlewares/requireAdmin";
import * as ctrl from "./admin.controller";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/stats", ctrl.getStats);
adminRouter.get("/users", ctrl.getRecentUsers);
adminRouter.get("/health", ctrl.getPlatformHealth);
