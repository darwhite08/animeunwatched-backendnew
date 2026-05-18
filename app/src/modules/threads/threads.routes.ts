import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./threads.controller";

export const threadsRouter = Router();

// Thread CRUD
threadsRouter.get("/:id", optionalAuth, ctrl.getThreadById);
threadsRouter.patch("/:id", requireAuth, ctrl.updateThread);
threadsRouter.delete("/:id", requireAuth, ctrl.deleteThread);

// Replies
threadsRouter.get("/:id/replies", optionalAuth, ctrl.getReplies);
threadsRouter.post("/:id/replies", requireAuth, ctrl.createReply);

// ─── Club thread sub-router (mounted at /clubs/:slug in routes.ts) ─────────
// Exported separately so it can be mounted under clubsRouter
export const clubThreadsRouter = Router({ mergeParams: true });
clubThreadsRouter.get("/", optionalAuth, ctrl.getClubThreads);
clubThreadsRouter.post("/", requireAuth, ctrl.createClubThread);

// ─── Anime thread sub-router (mounted at /anime/:malId in routes.ts) ────────
export const animeThreadsRouter = Router({ mergeParams: true });
animeThreadsRouter.get("/", optionalAuth, ctrl.getAnimeThreads);
animeThreadsRouter.post("/", requireAuth, ctrl.createAnimeThread);
