import { Router } from "express";
import * as ctrl from "./readlist.controller";
import { requireAuth, requireVerifiedEmail } from "../../middlewares/auth.middleware";

export const readlistRouter = Router();

// Static routes first so they win over the dynamic /:username.
readlistRouter.get("/search", requireAuth, ctrl.search);   // AniList manga search
readlistRouter.get("/me",     requireAuth, ctrl.getMine);

readlistRouter.post("/",          requireAuth, requireVerifiedEmail, ctrl.add);
readlistRouter.patch("/:id",      requireAuth, ctrl.update);
readlistRouter.delete("/:id",     requireAuth, ctrl.remove);

// Public — view a user's reading list by username.
readlistRouter.get("/:username", ctrl.getByUsername);
