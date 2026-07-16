import { Router } from "express";
import { optionalAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./manga.controller";

export const mangaRouter = Router();

// NOTE: named routes must come before the dynamic /:malId (same as anime).
mangaRouter.get("/search", optionalAuth, ctrl.search);
mangaRouter.post("/request-title", optionalAuth, ctrl.requestTitle);
mangaRouter.get("/sitemap", ctrl.getSitemap); // SEO: all index-worthy manga (malId + lastmod)
mangaRouter.get("/genres", ctrl.listGenres); // distinct catalog genres used by manga
mangaRouter.get("/:malId/user-stats", optionalAuth, ctrl.getMangaUserStats);
mangaRouter.get("/:malId", optionalAuth, ctrl.getById); // numeric malId OR seo slug
mangaRouter.get("/", optionalAuth, ctrl.browse);
