import { Request, Response, NextFunction } from "express";
import { createBlogSchema, updateBlogSchema } from "./blogs.schema";
import * as service from "./blogs.service";

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const result = await service.list(page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getBySlug(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const slug = req.params.slug as string;
    const userId: string | undefined = res.locals.user?.id;
    const result = await service.getBySlug(slug, userId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function createBlog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authorId: string = res.locals.user.id;
    const dto = createBlogSchema.parse(req.body);
    const result = await service.create(authorId, dto);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateBlog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const slug = req.params.slug as string;
    const dto = updateBlogSchema.parse(req.body);
    const result = await service.update(slug, userId, dto);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function deleteBlog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const userRole: string = res.locals.user.role;
    const slug = req.params.slug as string;
    await service.deleteBlog(slug, userId, userRole);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
