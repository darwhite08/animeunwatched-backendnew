import { Request, Response, NextFunction } from "express";
import { createPostSchema, createCommentSchema } from "./posts.schema";
import * as service from "./posts.service";

export async function getFeed(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const cursor = req.query.cursor as string | undefined;
    const limit = Number(req.query.limit) || 20;
    const result = await service.getFeed(userId, cursor, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getDiscover(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const cursor = req.query.cursor as string | undefined;
    const limit  = Number(req.query.limit) || 20;
    const userId = (req as any).user?.id as string | undefined; // set by optionalAuth
    const result = await service.getDiscover(userId, cursor, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getPost(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string | undefined = res.locals.user?.id;
    const result = await service.getPost((req.params.id as string), userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function createPost(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authorId: string = res.locals.user.id;
    const dto = createPostSchema.parse(req.body);
    const result = await service.createPost(authorId, dto);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function deletePost(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const userRole: string = res.locals.user.role;
    await service.deletePost((req.params.id as string), userId, userRole);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function likePost(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    await service.likePost(userId, (req.params.id as string));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function unlikePost(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    await service.unlikePost(userId, (req.params.id as string));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function getComments(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const result = await service.getComments((req.params.id as string), page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function createComment(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authorId: string = res.locals.user.id;
    const { content } = createCommentSchema.parse(req.body);
    const result = await service.createComment((req.params.id as string), authorId, content);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}
