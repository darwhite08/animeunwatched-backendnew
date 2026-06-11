import { Request, Response, NextFunction } from "express";
import { blogCategoryEnum, createBlogSchema, updateBlogSchema } from "./blogs.schema";
import * as service from "./blogs.service";

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const category = blogCategoryEnum.optional().catch(undefined).parse(req.query.category);
    const result = await service.list(page, limit, category);
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

/** POST /blogs/:slug/view — record a (deduplicated) read; returns the live count. */
export async function recordView(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const slug = req.params.slug as string;
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() ?? req.ip;
    const result = await service.recordView(slug, {
      userId: res.locals.user?.id as string | undefined,
      ip,
      userAgent: req.header("User-Agent") ?? undefined,
    });
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

export async function getComments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page  = Number(req.query.page) || 1
    const result = await service.getComments(req.params.slug as string, page)
    res.status(200).json(result)
  } catch (err) { next(err) }
}

export async function createComment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authorId = res.locals.user?.id as string
    const { content } = req.body as { content: string }
    if (!content?.trim()) { res.status(400).json({ error: { code: "VALIDATION", message: "Content required" } }); return }
    const result = await service.createComment(req.params.slug as string, authorId, content.trim())
    res.status(201).json(result)
  } catch (err) { next(err) }
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
