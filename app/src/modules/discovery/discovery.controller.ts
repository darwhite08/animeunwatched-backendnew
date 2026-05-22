import type { Request, Response, NextFunction } from "express";
import { aiPromptSchema, moodSchema, quizSchema } from "./discovery.schema";
import * as service from "./discovery.service";
import { badRequest } from "../../lib/errors";

function parseOr400<T>(schema: { safeParse: (input: unknown) => { success: boolean; data?: T; error?: { issues: Array<{ message: string }> } } }, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw badRequest(parsed.error?.issues[0]?.message ?? "Invalid request");
  return parsed.data as T;
}

export async function ai(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = parseOr400(aiPromptSchema, req.body);
    const result = await service.aiDiscovery(dto);
    res.json(result);
  } catch (e) { next(e); }
}

export async function mood(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = parseOr400(moodSchema, req.body);
    const result = await service.moodDiscovery(dto);
    res.json(result);
  } catch (e) { next(e); }
}

export async function quiz(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = parseOr400(quizSchema, req.body);
    const result = await service.quizDiscovery(dto);
    res.json(result);
  } catch (e) { next(e); }
}
