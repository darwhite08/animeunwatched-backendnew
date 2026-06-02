import type { Request, Response, NextFunction } from "express";
import * as svc from "./users.service";
import { ipFromReq, uaFromReq } from "../../lib/adminAudit";
import { badRequest } from "../../lib/errors";

const requestMeta = (req: Request): { ipAddress: string | null; userAgent: string | null } => ({
  ipAddress: ipFromReq(req),
  userAgent: uaFromReq(req),
});

export async function patchUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const userId  = req.params.userId as string;
    const patch = {
      displayName: typeof req.body?.displayName === "string"          ? req.body.displayName : undefined,
      bio:         typeof req.body?.bio         === "string" || req.body?.bio === null ? req.body.bio : undefined,
      reputation:  typeof req.body?.reputation  === "number"          ? req.body.reputation : undefined,
    };
    const result = await svc.updateUser({ actorId, userId, patch, ...requestMeta(req) });
    res.status(200).json(result);
  } catch (err) { next(err); }
}

export async function passwordReset(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const userId  = req.params.userId as string;
    const result = await svc.adminGeneratePasswordReset({ actorId, userId, ...requestMeta(req) });
    res.status(200).json(result);
  } catch (err) { next(err); }
}

export async function resetMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const userId  = req.params.userId as string;
    const result = await svc.adminResetMfa({ actorId, userId, ...requestMeta(req) });
    res.status(200).json(result);
  } catch (err) { next(err); }
}

export async function revokeSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const userId  = req.params.userId as string;
    const result = await svc.adminRevokeSessions({ actorId, userId, ...requestMeta(req) });
    res.status(200).json(result);
  } catch (err) { next(err); }
}

export async function getUserSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.params.userId as string;
    const result = await svc.listUserSessions(userId);
    res.status(200).json(result);
  } catch (err) { next(err); }
}

export async function createInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const { email, roleName } = req.body as { email?: string; roleName?: string };
    if (!email) throw badRequest("email required");
    const result = await svc.createInvite({ actorId, email, roleName, ...requestMeta(req) });
    res.status(200).json(result);
  } catch (err) { next(err); }
}

export async function listInvites(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page  = Math.max(1, Number(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    res.status(200).json(await svc.listInvites({ page, limit }));
  } catch (err) { next(err); }
}

export async function revokeInvite(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId  = res.locals.user?.id as string;
    const inviteId = req.params.inviteId as string;
    res.status(200).json(await svc.revokeInvite({ actorId, inviteId, ...requestMeta(req) }));
  } catch (err) { next(err); }
}

export async function bulkAction(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const { userIds, action, reason } = req.body as {
      userIds?: string[]; action?: string; reason?: string;
    };
    if (!Array.isArray(userIds))                    throw badRequest("userIds[] required");
    if (!action || !["ban","unban","revoke_sessions"].includes(action)) {
      throw badRequest("action must be ban|unban|revoke_sessions");
    }
    const result = await svc.bulkUserAction({
      actorId, userIds, action: action as "ban" | "unban" | "revoke_sessions", reason, ...requestMeta(req),
    });
    res.status(200).json(result);
  } catch (err) { next(err); }
}

export async function softDelete(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const userId  = req.params.userId as string;
    res.status(200).json(await svc.softDeleteUser({ actorId, userId, ...requestMeta(req) }));
  } catch (err) { next(err); }
}
