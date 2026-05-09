import { Request, Response, NextFunction } from "express";
import { createPollSchema, voteSchema } from "./polls.schema";
import * as service from "./polls.service";

export async function listPolls(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const result = await service.list(page, limit);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function createPoll(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const authorId: string = res.locals.user.id;
    const dto = createPollSchema.parse(req.body);
    const result = await service.create(authorId, dto);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getPollById(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await service.getById(req.params.id as string);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function votePoll(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId: string = res.locals.user.id;
    const pollId = req.params.id as string;
    const { optionId } = voteSchema.parse(req.body);
    const result = await service.vote(pollId, userId, optionId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
