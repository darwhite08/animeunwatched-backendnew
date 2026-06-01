import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./activities.controller";

export const activitiesRouter = Router();

// Specific named routes before dynamic /:id
activitiesRouter.get("/feed", optionalAuth, ctrl.getFeed);

activitiesRouter.post("/", requireAuth, ctrl.createActivity);
activitiesRouter.get("/:id", optionalAuth, ctrl.getActivity);
activitiesRouter.delete("/:id", requireAuth, ctrl.deleteActivity);

activitiesRouter.post("/:id/like", requireAuth, ctrl.likeActivity);
activitiesRouter.delete("/:id/like", requireAuth, ctrl.unlikeActivity);

activitiesRouter.post("/:id/repost", requireAuth, ctrl.repostActivity);
activitiesRouter.delete("/:id/repost", requireAuth, ctrl.unrepostActivity);

activitiesRouter.get("/:id/replies", optionalAuth, ctrl.getReplies);
activitiesRouter.post("/:id/replies", requireAuth, ctrl.createReply);
