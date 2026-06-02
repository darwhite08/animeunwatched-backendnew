import type { Request, Response, NextFunction } from "express";
import { mailerStatus, sendMail } from "../../lib/mailer";
import { badRequest } from "../../lib/errors";
import { adminAuditR } from "../../lib/adminAudit";

/**
 * Mailer admin surface. Exposes status (configured? host? from-address?) so
 * operators can verify SMTP settings, and a test-send endpoint for sanity
 * checks before scheduling reports.
 */

export function getMailerStatus(_req: Request, res: Response): void {
  res.status(200).json(mailerStatus());
}

export async function sendTestEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { to } = req.body as { to?: string };
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw badRequest("'to' must be a valid email");

    const result = await sendMail({
      to,
      subject: "[Kaiveron] Admin mailer test",
      text:    `This is a test email from the Kaiveron admin console.\n\nIf you received this, SMTP is working.\n\nSent at ${new Date().toISOString()}.`,
      tag:     "test",
    });

    await adminAuditR(req, res, {
      action:   "mailer.test_send",
      metadata: { to, ok: result.ok, dryRun: result.dryRun, error: result.error },
    });

    res.status(200).json(result);
  } catch (err) { next(err); }
}
