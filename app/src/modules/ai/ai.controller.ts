import { NextFunction, Request, Response } from "express";
import { badRequest } from "../../lib/errors";
import { askSchema, writeSchema } from "./ai.schema";
import * as service from "./ai.service";

export async function ask(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid prompt");
    const result = await service.ask(parsed.data.prompt);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function write(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = writeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid write request");
    const { action, prompt, context } = parsed.data;
    res.status(200).json(await service.write(action, prompt, context));
  } catch (err) {
    next(err);
  }
}
