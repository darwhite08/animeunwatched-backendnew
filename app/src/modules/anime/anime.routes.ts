import { Router } from "express";
import { optionalAuth, requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./anime.controller";

export const animeRouter = Router();

// NOTE: named routes (/search, /season/..., /trending) must come before dynamic /:malId
animeRouter.get("/search", optionalAuth, ctrl.search);
animeRouter.get("/trending", ctrl.getTrending);
animeRouter.get("/for-you", requireAuth, ctrl.getForYou);  // personalised recs
animeRouter.get("/top", ctrl.getTrending);        // alias: GET /anime/top?limit=20
animeRouter.get("/genres",  ctrl.listGenres);     // distinct catalog genres
animeRouter.get("/studios", ctrl.listStudios);    // distinct catalog studios
animeRouter.get("/season/:year/:season", optionalAuth, ctrl.getSeasonal);
animeRouter.get("/:malId/similar",     optionalAuth, ctrl.getSimilar);
animeRouter.get("/:malId/user-stats",  optionalAuth, ctrl.getAnimeUserStats);
animeRouter.get("/:malId/characters",  optionalAuth, ctrl.getCharacters);
animeRouter.get("/:malId/staff",       optionalAuth, ctrl.getStaff);
animeRouter.get("/:malId/episodes",    optionalAuth, ctrl.getEpisodes);
animeRouter.get("/:malId/franchise",   optionalAuth, ctrl.getFranchise);
animeRouter.get("/:malId",             optionalAuth, ctrl.getById);
animeRouter.get("/", optionalAuth, ctrl.browse);
