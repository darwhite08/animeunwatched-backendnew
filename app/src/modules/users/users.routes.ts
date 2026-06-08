import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import { requireAdmin } from "../../middlewares/requireAdmin";
import * as ctrl from "./users.controller";

export const usersRouter = Router();

// ── Static routes MUST be registered before dynamic /:username routes ─────────
usersRouter.patch("/me",                      requireAuth, ctrl.updateMe);
usersRouter.get("/me/export",                 requireAuth, ctrl.exportMyData);
usersRouter.get("/me/connected-accounts",     requireAuth, ctrl.getConnectedAccounts);
// Slug management — auth required; slug is the routing alias, never a data key
usersRouter.patch("/me/slug",                 requireAuth, ctrl.updateSlug);
usersRouter.get("/slug-check",       ctrl.checkSlugAvailable);   // ?slug=foo  (public, no rate-limit hit)
// Username change (the @handle) — auth required; availability check is public-ish
usersRouter.patch("/me/username",             requireAuth, ctrl.changeUsername);
usersRouter.get("/username-check",   optionalAuth, ctrl.checkUsernameAvailable);  // ?username=foo
// Leaderboard must be before /:username or Express will match 'leaderboard' as username
usersRouter.get("/leaderboard/top", ctrl.getLeaderboard);
// Personalised people-you-may-know — FOAF + taste similarity + recency
usersRouter.get("/suggestions",     requireAuth, ctrl.whoToFollow);

// Follow requests (private accounts)
usersRouter.get( "/me/follow-requests",                     requireAuth, ctrl.getFollowRequests);
usersRouter.post("/me/follow-requests/:requesterId/accept", requireAuth, ctrl.acceptFollowRequest);
usersRouter.post("/me/follow-requests/:requesterId/reject", requireAuth, ctrl.rejectFollowRequest);

// Verified badge — admin only
usersRouter.patch("/:username/verify",     requireAuth, requireAdmin, ctrl.setVerification);

// ── Dynamic routes ────────────────────────────────────────────────────────────
usersRouter.get("/:username",              optionalAuth, ctrl.getProfile);
usersRouter.post("/:username/follow",      requireAuth,  ctrl.follow);
usersRouter.delete("/:username/follow",    requireAuth,  ctrl.unfollow);
usersRouter.get("/:username/xp",           ctrl.getXp);
usersRouter.get("/:username/followers",    optionalAuth, ctrl.getFollowers);
usersRouter.get("/:username/following",    optionalAuth, ctrl.getFollowing);
usersRouter.get("/:username/stats",        optionalAuth, ctrl.getUserStats);
usersRouter.get("/:username/activity",           optionalAuth, ctrl.getActivity);
usersRouter.get("/:username/following-activity", optionalAuth, ctrl.getFollowingActivity);
usersRouter.get("/:username/posts",              optionalAuth, ctrl.getUserPosts);
