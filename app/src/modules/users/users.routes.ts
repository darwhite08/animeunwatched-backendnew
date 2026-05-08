import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./users.controller";

export const usersRouter = Router();

// Specific routes before dynamic /:username
usersRouter.patch("/me", requireAuth, ctrl.updateMe);

usersRouter.get("/:username", optionalAuth, ctrl.getProfile);
usersRouter.post("/:username/follow", requireAuth, ctrl.follow);
usersRouter.delete("/:username/follow", requireAuth, ctrl.unfollow);
usersRouter.get("/:username/followers", optionalAuth, ctrl.getFollowers);
usersRouter.get("/:username/following", optionalAuth, ctrl.getFollowing);
