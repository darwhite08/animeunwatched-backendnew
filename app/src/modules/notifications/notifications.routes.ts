import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./notifications.controller";

export const notificationsRouter = Router();

// NOTE: /read-all must be before /:id to avoid route collision
notificationsRouter.get("/", requireAuth, ctrl.list);
notificationsRouter.get("/unread-count", requireAuth, ctrl.getUnreadCount);
notificationsRouter.patch("/read-all", requireAuth, ctrl.markAllRead);
notificationsRouter.patch("/:id/read", requireAuth, ctrl.markRead);

// Notification preferences are stored client-side (localStorage)
// This endpoint is a no-op that returns 204 so the frontend can save preferences
notificationsRouter.put("/preferences", requireAuth, (req, res) => { res.status(204).send() })
notificationsRouter.get("/preferences", requireAuth, (req, res) => {
  // Returns empty object — preferences live in the client
  res.status(200).json({ preferences: {} })
})
