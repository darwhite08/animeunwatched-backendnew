import { Request, Response, NextFunction } from "express";
import * as safety from "./safety.service";
import { reportSchema, reportContentSchema } from "./safety.schema";

export async function blockUser(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await safety.blockUser(res.locals.user.id as string, req.params.id as string);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function unblockUser(req: Request, res: Response, next: NextFunction) {
  try {
    await safety.unblockUser(res.locals.user.id as string, req.params.id as string);
    res.status(204).send();
  } catch (err) { next(err); }
}

export async function listBlocked(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await safety.listBlocked(res.locals.user.id as string);
    res.json({ blocked: result });
  } catch (err) { next(err); }
}

export async function report(req: Request, res: Response, next: NextFunction) {
  try {
    const { body } = reportSchema.parse({ body: req.body });
    const result = await safety.reportConversation(res.locals.user.id as string, body as Parameters<typeof safety.reportConversation>[1]);
    res.status(201).json({ report: result });
  } catch (err) { next(err); }
}

export async function reportContent(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = reportContentSchema.parse(req.body);
    const result = await safety.reportContent(res.locals.user.id as string, dto);
    res.status(201).json({ report: result });
  } catch (err) { next(err); }
}
