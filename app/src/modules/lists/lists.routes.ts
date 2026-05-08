import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./lists.controller";

export const listsRouter = Router();

// Specific /me routes before dynamic /:username
listsRouter.put("/me/:animeId", requireAuth, ctrl.upsertEntry);
listsRouter.delete("/me/:animeId", requireAuth, ctrl.deleteEntry);
listsRouter.get("/:username", optionalAuth, ctrl.getUserList);
