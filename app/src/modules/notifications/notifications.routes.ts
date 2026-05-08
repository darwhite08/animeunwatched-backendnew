import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./notifications.controller";

export const notificationsRouter = Router();

// NOTE: /read-all must be before /:id to avoid route collision
notificationsRouter.get("/", requireAuth, ctrl.list);
notificationsRouter.get("/unread-count", requireAuth, ctrl.getUnreadCount);
notificationsRouter.patch("/read-all", requireAuth, ctrl.markAllRead);
notificationsRouter.patch("/:id/read", requireAuth, ctrl.markRead);
