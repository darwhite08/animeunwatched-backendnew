import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { requireStepUp } from "../../lib/stepup";
import * as ctrl from "./clubs.controller";
import { clubThreadsRouter } from "../threads/threads.routes";
import { clubEventsRouter } from "../events/events.routes";

export const clubsRouter = Router();

// List all clubs (optional auth)
clubsRouter.get("/", optionalAuth, ctrl.listClubs);

// Create a club (auth required)
clubsRouter.post("/", requireAuth, ctrl.createClub);

// Verified badge — admin only
clubsRouter.patch("/:slug/verify", requireAuth, requireAdmin, requireStepUp("verify"), ctrl.setVerified);

// Invite links (2-segment paths — no collision with GET /:slug)
clubsRouter.get("/invite/:code", optionalAuth, ctrl.inviteInfo);
clubsRouter.post("/invite/:code/join", requireAuth, ctrl.joinViaInvite);

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
// Club polls (vote via the existing POST /polls/:id/vote)
clubsRouter.get("/:slug/polls",  optionalAuth, ctrl.listClubPolls);
clubsRouter.post("/:slug/polls", requireAuth, ctrl.createClubPoll);
// Shared watchlist (P2)
clubsRouter.get("/:slug/watchlist", optionalAuth, ctrl.getWatchlist);
clubsRouter.post("/:slug/watchlist", requireAuth, ctrl.addWatchlist);
clubsRouter.delete("/:slug/watchlist/:malId", requireAuth, ctrl.removeWatchlist);
// Moderation (mod/admin)
clubsRouter.post("/:slug/members/:userId/mute",   requireAuth, ctrl.muteMember);
clubsRouter.post("/:slug/members/:userId/remove", requireAuth, ctrl.removeMember);
// Private clubs: invite creation + join-request queue (mod/admin)
clubsRouter.post("/:slug/invites", requireAuth, ctrl.createInvite);
clubsRouter.get("/:slug/requests", requireAuth, ctrl.listJoinRequests);
clubsRouter.post("/:slug/requests/:userId/decide", requireAuth, ctrl.decideJoinRequest);

// Club threads: POST /clubs/:slug/threads
clubsRouter.use("/:slug/threads", clubThreadsRouter);
// Club events: GET/POST /clubs/:slug/events
clubsRouter.use("/:slug/events", clubEventsRouter);
