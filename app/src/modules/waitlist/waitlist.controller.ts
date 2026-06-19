import { Request, Response, NextFunction } from "express";
import * as service from "./waitlist.service";
import { joinWaitlistSchema } from "./waitlist.schema";
import { badRequest } from "../../lib/errors";

/** POST /waitlist — public. Capture an email for the invite-only waitlist. */
export async function join(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = joinWaitlistSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("Please enter a valid email address.", "VALIDATION");
    }
    const result = await service.joinWaitlist(parsed.data);
    res.status(200).json(result);
  } catch (err) { next(err); }
}

/** GET /waitlist — admin. List captured emails (newest first). */
export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const take = req.query.take ? Number(req.query.take) : undefined;
    const skip = req.query.skip ? Number(req.query.skip) : undefined;
    res.status(200).json(await service.listWaitlist({ take, skip }));
  } catch (err) { next(err); }
}
