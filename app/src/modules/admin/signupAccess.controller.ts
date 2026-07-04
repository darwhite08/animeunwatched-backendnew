import type { Request, Response, NextFunction } from "express";
import { adminAudit, ipFromReq, uaFromReq } from "../../lib/adminAudit";
import * as gate from "../../lib/inviteGate";
import * as waitlist from "../waitlist/waitlist.service";
import { badRequest } from "../../lib/errors";

// Signup access control: the invite-only gate toggle + its invite codes.
// All routes here inherit requireAuth + requireAdmin from the admin router.

export async function getAccess(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const [inviteOnly, invites] = await Promise.all([gate.getInviteOnly(), gate.listSignupInvites()]);
    res.status(200).json({ inviteOnly, invites });
  } catch (err) { next(err); }
}

export async function setAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const enabled = req.body?.inviteOnly === true || req.body?.enabled === true;
    const result = await gate.setInviteOnly(enabled, actorId);
    await adminAudit({
      actorId, action: enabled ? "signup.invite_only.on" : "signup.invite_only.off",
      targetType: "AdminSetting", targetId: "invite_only", metadata: { enabled },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json(result);
  } catch (err) { next(err); }
}

export async function createInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const { label, maxUses, expiresInDays } = (req.body ?? {}) as { label?: string; maxUses?: number; expiresInDays?: number };
    const invite = await gate.createSignupInvite({
      label,
      maxUses: Number(maxUses) || 0,
      expiresInDays: Number(expiresInDays) || 0,
      actorId,
    });
    await adminAudit({
      actorId, action: "signup.invite.create", targetType: "SignupInvite", targetId: invite.id,
      metadata: { code: invite.code, maxUses: invite.maxUses }, ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(201).json(invite);
  } catch (err) { next(err); }
}

/**
 * POST /admin/signup-access/invite — email a signup link to one or many addresses.
 * Body: { emails: string[] | string, code?: string, maxUses?, expiresInDays?, label? }
 * If no `code` is given, generates a fresh SignupInvite sized to the batch.
 * Members are skipped; recipients are recorded in the waitlist as invited.
 */
export async function bulkInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const body = (req.body ?? {}) as {
      emails?: string[] | string; code?: string; maxUses?: number; expiresInDays?: number; label?: string;
    };

    const raw = Array.isArray(body.emails) ? body.emails.join(",") : String(body.emails ?? "");
    const emails = raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (emails.length === 0) throw badRequest("Provide at least one email address.", "VALIDATION");
    if (emails.length > 500) throw badRequest("Max 500 emails per invite batch — split into smaller batches.", "VALIDATION");

    // Use the provided code, or mint a fresh one sized to the batch.
    let code = typeof body.code === "string" ? body.code.trim() : "";
    let generated = false;
    if (!code) {
      const invite = await gate.createSignupInvite({
        label: body.label?.trim() || `Admin invite (${emails.length})`,
        maxUses: Number(body.maxUses) || emails.length,
        expiresInDays: Number(body.expiresInDays) || 14,
        actorId,
      });
      code = invite.code;
      generated = true;
    }

    const result = await waitlist.inviteEmails(emails, code);

    await adminAudit({
      actorId, action: "signup.invite.email", targetType: "SignupInvite", targetId: code,
      metadata: { code, generated, sent: result.sent, skippedMembers: result.skippedMembers.length, invalid: result.invalid.length, failed: result.failed.length },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });

    res.status(200).json({ ...result, code, generated });
  } catch (err) { next(err); }
}

export async function revokeInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const id = req.params.id as string;
    const invite = await gate.revokeSignupInvite(id);
    await adminAudit({
      actorId, action: "signup.invite.revoke", targetType: "SignupInvite", targetId: id,
      metadata: {}, ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json(invite);
  } catch (err) { next(err); }
}
