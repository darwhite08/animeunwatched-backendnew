import { Request, Response, NextFunction } from "express";
import { updateMeSchema } from "./users.schema";
import * as service from "./users.service";

export async function getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.getProfile((req.params.username as string));
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function updateMe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const dto = updateMeSchema.parse(req.body);
    const result = await service.updateMe(userId, dto);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function follow(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const followerId: string = res.locals.user.id;
    await service.follow(followerId, (req.params.username as string));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function unfollow(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const followerId: string = res.locals.user.id;
    await service.unfollow(followerId, (req.params.username as string));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

export async function getFollowers(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const result = await service.getFollowers((req.params.username as string), page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getXp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.getXp((req.params.username as string));
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getFollowing(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const result = await service.getFollowing((req.params.username as string), page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getUserStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await service.getUserStats(req.params.username as string);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function exportMyData(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const data = await service.exportMyData(userId);
    res.setHeader("Content-Disposition", 'attachment; filename="my-data.json"');
    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
}

export async function getActivity(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Number(req.query.limit) || 20;
    const result = await service.getActivity(req.params.username as string, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
