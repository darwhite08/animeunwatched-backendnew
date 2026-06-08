import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import { rateLimit } from "../../middlewares/rateLimit.middleware";
import * as ctrl from "./events.controller";

// Mounted at /events for single-event ops.
export const eventsRouter = Router();
eventsRouter.get("/:id", optionalAuth, ctrl.getEvent);
eventsRouter.patch("/:id", requireAuth, ctrl.updateEvent);
eventsRouter.delete("/:id", requireAuth, ctrl.deleteEvent);
eventsRouter.put("/:id/rsvp", requireAuth, ctrl.rsvp);

// Mounted under /clubs/:slug/events for club-scoped list/create.
export const clubEventsRouter = Router({ mergeParams: true });
clubEventsRouter.get("/", optionalAuth, ctrl.listClubEvents);
clubEventsRouter.post("/", requireAuth, rateLimit(20, 60 * 60_000, { perUser: true, bucket: "club-event-create" }), ctrl.createClubEvent);
