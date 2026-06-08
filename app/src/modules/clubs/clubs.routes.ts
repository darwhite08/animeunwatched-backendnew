import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./clubs.controller";
import { clubThreadsRouter } from "../threads/threads.routes";
import { clubEventsRouter } from "../events/events.routes";

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
// Realtime club chat room (lazily created; membership mirrors ClubMember).
clubsRouter.get("/:slug/chat", requireAuth, ctrl.clubChat);
// Onboarding + gamification
clubsRouter.post("/:slug/onboard", requireAuth, ctrl.onboard);
clubsRouter.get("/:slug/leaderboard", optionalAuth, ctrl.leaderboard);

// Club threads: POST /clubs/:slug/threads
clubsRouter.use("/:slug/threads", clubThreadsRouter);
// Club events: GET/POST /clubs/:slug/events
clubsRouter.use("/:slug/events", clubEventsRouter);
