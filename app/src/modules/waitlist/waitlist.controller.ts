import { Request, Response, NextFunction } from "express";
import * as service from "./waitlist.service";
import { joinWaitlistSchema } from "./waitlist.schema";
import { badRequest } from "../../lib/errors";
import { env } from "../../config/env";

function verifyCronSecret(req: Request): boolean {
  const secret = req.headers["x-cron-secret"] ?? req.query.secret;
  return !!env.CRON_SECRET && secret === env.CRON_SECRET;
}

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

/** DELETE /waitlist — admin. Remove waitlist rows by email. Body: { emails: string[] }. */
export async function remove(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = (req.body ?? {}) as { emails?: unknown };
    const emails = Array.isArray(raw.emails)
      ? raw.emails.filter((x): x is string => typeof x === "string")
      : [];
    if (!emails.length) throw badRequest("Provide emails[] to delete.", "VALIDATION");
    const deleted = await service.deleteByEmails(emails);
    res.status(200).json({ deleted });
  } catch (err) { next(err); }
}

/**
 * POST /waitlist/send-invites — CRON_SECRET-gated. Sends the "your spot opened"
 * invite to the waitlist cohort. Always prunes registered members first.
 * Body: { invite?: string, dryRun?: boolean, resend?: boolean, limit?: number }
 * Use dryRun:true first to verify the invite code and preview recipient count.
 */
export async function sendInvites(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!verifyCronSecret(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Out-of-band bookkeeping: flag emails as invited without sending.
    if (Array.isArray(body.markInvited)) {
      const marked = await service.markInvited(body.markInvited.filter((x): x is string => typeof x === "string"));
      res.status(200).json({ marked });
      return;
    }
    const result = await service.sendWaitlistInvites({
      invite: typeof body.invite === "string" ? body.invite : undefined,
      dryRun: body.dryRun === true || body.dryRun === "true",
      resend: body.resend === true || body.resend === "true",
      limit:  body.limit != null ? Number(body.limit) : undefined,
    });
    res.status(200).json(result);
  } catch (err) { next(err); }
}
