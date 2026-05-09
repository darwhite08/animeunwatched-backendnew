import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./clubs.controller";
import { clubThreadsRouter } from "../threads/threads.routes";

export const clubsRouter = Router();

// List all clubs (optional auth)
clubsRouter.get("/", optionalAuth, ctrl.listClubs);

// Create a club (auth required)
clubsRouter.post("/", requireAuth, ctrl.createClub);

// Specific slug routes
clubsRouter.get("/:slug", optionalAuth, ctrl.getClubBySlug);
clubsRouter.patch("/:slug", requireAuth, ctrl.updateClub);
clubsRouter.post("/:slug/join", requireAuth, ctrl.joinClub);
clubsRouter.delete("/:slug/membership", requireAuth, ctrl.leaveClub);
clubsRouter.get("/:slug/members", optionalAuth, ctrl.getClubMembers);
clubsRouter.patch("/:slug/members/:userId", requireAuth, ctrl.setMemberRole);

// Club threads: POST /clubs/:slug/threads
clubsRouter.use("/:slug/threads", clubThreadsRouter);
