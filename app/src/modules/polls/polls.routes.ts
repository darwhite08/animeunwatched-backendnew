import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./polls.controller";

export const pollsRouter = Router();

// List polls (optional auth)
pollsRouter.get("/", optionalAuth, ctrl.listPolls);

// Create a poll (auth required)
pollsRouter.post("/", requireAuth, ctrl.createPoll);

// Get single poll (optional auth)
pollsRouter.get("/:id", optionalAuth, ctrl.getPollById);

// Vote on a poll (auth required)
pollsRouter.post("/:id/vote", requireAuth, ctrl.votePoll);
