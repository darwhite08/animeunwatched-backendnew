import type { Request, Response, NextFunction } from "express";
import { adminAudit, ipFromReq, uaFromReq } from "../../lib/adminAudit";
import * as gate from "../../lib/inviteGate";

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
