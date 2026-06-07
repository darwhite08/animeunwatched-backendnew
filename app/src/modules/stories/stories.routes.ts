import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./stories.controller";

export const storiesRouter = Router();

storiesRouter.get("/feed", requireAuth, ctrl.getFeed);
storiesRouter.post("/", requireAuth, ctrl.createStory);
storiesRouter.post("/:id/view", requireAuth, ctrl.markViewed);
storiesRouter.delete("/:id", requireAuth, ctrl.deleteStory);
