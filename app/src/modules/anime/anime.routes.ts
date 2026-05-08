import { Router } from "express";
import { optionalAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./anime.controller";

export const animeRouter = Router();

// NOTE: named routes (/search, /season/...) must come before dynamic /:malId
animeRouter.get("/search", optionalAuth, ctrl.search);
animeRouter.get("/season/:year/:season", optionalAuth, ctrl.getSeasonal);
animeRouter.get("/:malId", optionalAuth, ctrl.getById);
animeRouter.get("/", optionalAuth, ctrl.browse);
