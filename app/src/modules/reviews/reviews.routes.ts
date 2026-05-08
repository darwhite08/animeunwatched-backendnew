import { Router } from "express";
import { requireAuth, optionalAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./reviews.controller";

export const reviewsRouter = Router();

// GET /anime/:animeId/reviews — anime-scoped reviews (optional auth)
export const reviewsAnimeRouter = Router({ mergeParams: true });
reviewsAnimeRouter.get("/", optionalAuth, ctrl.getAnimeReviews);

// CRUD + like/unlike
reviewsRouter.post("/", requireAuth, ctrl.createReview);
reviewsRouter.patch("/:id", requireAuth, ctrl.updateReview);
reviewsRouter.delete("/:id", requireAuth, ctrl.deleteReview);
reviewsRouter.post("/:id/like", requireAuth, ctrl.likeReview);
reviewsRouter.delete("/:id/like", requireAuth, ctrl.unlikeReview);
