import { Request, Response, NextFunction } from "express";
import { createKeySchema, submitDraftSchema } from "./integrations.schema";
import * as service from "./integrations.service";

// ─── Key management (session-authed creator) ─────────────────────────────────

export async function createKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { label } = createKeySchema.parse(req.body);
    const result = await service.createKey(res.locals.user.id as string, label);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function listKeys(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await service.listKeys(res.locals.user.id as string));
  } catch (err) { next(err); }
}

export async function revokeKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.status(200).json(await service.revokeKey(res.locals.user.id as string, req.params.id as string));
  } catch (err) { next(err); }
}

export async function testKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const draft = await service.testKey(res.locals.user.id as string, req.params.id as string);
    res.status(draft.deduped ? 200 : 201).json(draft);
  } catch (err) { next(err); }
}

// ─── Inbound intake (external service, Bearer key) ───────────────────────────

export async function submitDraft(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    const rawKey = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    const idem = req.header("Idempotency-Key") ?? undefined;
    const dto = submitDraftSchema.parse(req.body);
    const result = await service.submitDraft(rawKey, idem, dto);
    res.status(result.deduped ? 200 : 201).json({ id: result.id, status: result.status });
  } catch (err) { next(err); }
}
