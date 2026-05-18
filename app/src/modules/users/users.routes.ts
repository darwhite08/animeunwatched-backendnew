import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./users.controller";

export const usersRouter = Router();

// Specific routes before dynamic /:username
usersRouter.patch("/me", requireAuth, ctrl.updateMe);
usersRouter.get("/me/export", requireAuth, ctrl.exportMyData);

usersRouter.get("/:username", optionalAuth, ctrl.getProfile);
usersRouter.post("/:username/follow", requireAuth, ctrl.follow);
usersRouter.delete("/:username/follow", requireAuth, ctrl.unfollow);
usersRouter.get("/:username/xp", ctrl.getXp);
usersRouter.get("/:username/followers", optionalAuth, ctrl.getFollowers);
usersRouter.get("/:username/following", optionalAuth, ctrl.getFollowing);
usersRouter.get("/:username/stats", optionalAuth, ctrl.getUserStats);
usersRouter.get("/:username/activity", optionalAuth, ctrl.getActivity);

// Leaderboard — before dynamic routes
usersRouter.get("/leaderboard/top", ctrl.getLeaderboard);
