import { Request, Response, NextFunction } from "express";
import { createReviewSchema, updateReviewSchema } from "./reviews.schema";
import * as service from "./reviews.service";

export async function getAnimeReviews(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const animeId = req.params.animeId as string;
    const sort = (req.query.sort as "helpful" | "recent") || "recent";
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const result = await service.getAnimeReviews(animeId, sort, page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function createReview(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authorId: string = res.locals.user.id;
    const dto = createReviewSchema.parse(req.body);
    const result = await service.create(authorId, dto);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateReview(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const id = req.params.id as string;
    const dto = updateReviewSchema.parse(req.body);
    const result = await service.update(id, userId, dto);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function deleteReview(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const userRole: string = res.locals.user.role;
    const id = req.params.id as string;
    await service.deleteReview(id, userId, userRole);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function likeReview(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const reviewId = req.params.id as string;
    await service.like(userId, reviewId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function unlikeReview(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const reviewId = req.params.id as string;
    await service.unlike(userId, reviewId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
