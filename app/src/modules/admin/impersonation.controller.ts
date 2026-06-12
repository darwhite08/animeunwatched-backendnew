import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badRequest, forbidden, notFound } from "../../lib/errors";
import { signImpersonationToken } from "../auth/auth.service";
import { adminAudit, ipFromReq, uaFromReq } from "../../lib/adminAudit";
import { isEnabled } from "../../lib/featureFlags";

const SESSION_TTL_SEC = 30 * 60;

/**
 * Start an impersonation session. Required: a typed reason and the global
 * `impersonation.enabled` feature flag must NOT be killed. Cannot impersonate
 * other admins. Issues a SCOPED access token (30 min default).
 *
 * Step-up token required at the route layer (requirePermissionWithStepUp).
 */
export async function startImpersonation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const { targetUserId, reason } = req.body as { targetUserId?: string; reason?: string };
    if (!targetUserId) throw badRequest("targetUserId required");
    if (!reason || reason.length < 5) throw badRequest("reason (5+ chars) required");
    if (targetUserId === actorId) throw badRequest("Cannot impersonate yourself");

    // Global kill switch via feature flag
    const allowed = await isEnabled("impersonation.enabled");
    if (!allowed) throw forbidden("Impersonation is disabled by kill switch");

    const target = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, role: true, isBanned: true, username: true, email: true },
    });
    if (!target) throw notFound("Target user not found");
    if (target.role === "ADMIN") throw forbidden("Cannot impersonate another admin");

    const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000);
    const session = await prisma.impersonationSession.create({
      data: {
        impersonatorId: actorId,
        targetUserId,
        reason,
        ipAddress: ipFromReq(req),
        userAgent: uaFromReq(req),
        expiresAt,
      },
    });

    const token = signImpersonationToken({
      targetUserId,
      impersonatorId: actorId,
      sessionId:      session.id,
      expiresInSec:   SESSION_TTL_SEC,
    });

    await adminAudit({
      actorId, impersonatorId: actorId,
      action: "impersonation.start", targetType: "User", targetId: targetUserId,
      metadata: { sessionId: session.id, reason, ttlSec: SESSION_TTL_SEC },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });

    res.status(200).json({
      sessionId: session.id,
      token,
      target:    { id: target.id, username: target.username, email: target.email },
      expiresAt: expiresAt.toISOString(),
    });
  } catch (err) { next(err); }
}

/**
 * End the currently active impersonation session. Reads the session id from
 * the impersonation token in the request (set by auth.middleware).
 */
export async function stopImpersonation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = res.locals.impersonationId as string | undefined;
    if (!sessionId) throw badRequest("No active impersonation");
    const session = await prisma.impersonationSession.findUnique({ where: { id: sessionId } });
    if (!session) throw notFound("Session not found");
    // Initiator check: only the operator who STARTED this session may stop it.
    // (sessionId already comes from the caller's own impersonation token, so this
    // is defense-in-depth — it can't mismatch in practice.)
    const operatorId = res.locals.impersonator?.id as string | undefined;
    if (operatorId && session.impersonatorId !== operatorId) {
      throw forbidden("Only the operator who started this session can stop it");
    }
    if (session.endedAt) {
      res.status(200).json({ ok: true, alreadyEnded: true }); return;
    }
    await prisma.impersonationSession.update({
      where: { id: sessionId },
      data:  { endedAt: new Date(), endedReason: "operator_stop" },
    });
    await adminAudit({
      actorId:        session.impersonatorId,
      impersonatorId: session.impersonatorId,
      action:         "impersonation.stop",
      targetType:     "User",
      targetId:       session.targetUserId,
      metadata:       { sessionId, reason: "operator_stop" },
      ipAddress:      ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}

/** List all currently-active impersonation sessions across the platform. */
export async function listActive(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.impersonationSession.findMany({
      where:   { endedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { startedAt: "desc" },
    });
    res.status(200).json({ data });
  } catch (err) { next(err); }
}
