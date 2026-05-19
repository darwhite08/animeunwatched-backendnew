import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./users.controller";

export const usersRouter = Router();

// ── Static routes MUST be registered before dynamic /:username routes ─────────
usersRouter.patch("/me",         requireAuth, ctrl.updateMe);
usersRouter.get("/me/export",    requireAuth, ctrl.exportMyData);
// Leaderboard must be before /:username or Express will match 'leaderboard' as username
usersRouter.get("/leaderboard/top", ctrl.getLeaderboard);

// ── Dynamic routes ────────────────────────────────────────────────────────────
usersRouter.get("/:username",              optionalAuth, ctrl.getProfile);
usersRouter.post("/:username/follow",      requireAuth,  ctrl.follow);
usersRouter.delete("/:username/follow",    requireAuth,  ctrl.unfollow);
usersRouter.get("/:username/xp",           ctrl.getXp);
usersRouter.get("/:username/followers",    optionalAuth, ctrl.getFollowers);
usersRouter.get("/:username/following",    optionalAuth, ctrl.getFollowing);
usersRouter.get("/:username/stats",        optionalAuth, ctrl.getUserStats);
usersRouter.get("/:username/activity",     optionalAuth, ctrl.getActivity);
