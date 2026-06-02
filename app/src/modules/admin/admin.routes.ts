import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireAdmin } from "../../middlewares/requireAdmin";
import * as ctrl from "./admin.controller";

export const adminRouter = Router();

// Every admin route requires a valid Bearer token AND role=ADMIN.
adminRouter.use(requireAuth, requireAdmin);

// Headline / overview
adminRouter.get("/stats",            ctrl.getStats);
adminRouter.get("/health",           ctrl.getPlatformHealth);
adminRouter.get("/metrics/overview", ctrl.getMetricsOverview);
adminRouter.get("/analytics/live",   ctrl.getAnalyticsLive);
adminRouter.get("/ga/realtime",      ctrl.getGAAnalyticsLive);

// Users
adminRouter.get("/users",                  ctrl.listUsers);
adminRouter.get("/users/recent",           ctrl.getRecentUsers);
adminRouter.get("/users/:userId",          ctrl.getUserDetail);
adminRouter.post("/users/:userId/ban",     ctrl.banUser);
adminRouter.post("/users/:userId/unban",   ctrl.unbanUser);
adminRouter.post("/users/:userId/role",    ctrl.setUserRole);

// Moderation queue
adminRouter.get("/reports",                ctrl.listReports);
adminRouter.patch("/reports/:reportId",    ctrl.resolveReport);

// Audit log viewer
adminRouter.get("/audit",                  ctrl.listAuditLog);
