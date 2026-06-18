import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { unauth, forbidden } from "../lib/errors";
import { prisma } from "../config/prisma";

const userSelect = {
  id: true,
  email: true,
  emailVerifiedAt: true,
  username: true,
  slug: true,          // routing alias — required so /auth/me carries it through
  displayName: true,
  bio: true,
  avatarUrl: true,
  coverImage: true,
  role: true,
  reputation: true,
  isBanned: true,
  verifiedKind: true, communityLead: true,
  onboardedAt: true,
  emailOnNewMessage: true, // so settings can render the DM-email toggle's state
  createdAt: true,
} as const;

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return next(unauth());
    const token = header.slice(7);
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as {
      userId: string;
      impersonatorId?: string;
      impSessionId?:   string;
    };
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: userSelect,
    });
    if (!user) return next(unauth());
    if (user.isBanned) return next(unauth("Your account has been suspended"));
    res.locals.user = user;

    // Impersonation token: validate session is still active and load operator.
    // Banned operators or stopped/expired sessions are rejected.
    if (payload.impersonatorId && payload.impSessionId) {
      const [session, operator] = await Promise.all([
        prisma.impersonationSession.findUnique({ where: { id: payload.impSessionId } }),
        prisma.user.findUnique({ where: { id: payload.impersonatorId }, select: userSelect }),
      ]);
      if (!session || session.endedAt || session.expiresAt < new Date()) return next(unauth("Impersonation session ended"));
      if (!operator || operator.isBanned) return next(unauth("Impersonator unavailable"));
      res.locals.impersonator   = operator;
      res.locals.impersonationId = session.id;
    }
    next();
  } catch {
    next(unauth());
  }
}

export function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next();
  try {
    const payload = jwt.verify(header.slice(7), env.JWT_ACCESS_SECRET) as { userId: string };
    prisma.user
      .findUnique({ where: { id: payload.userId }, select: userSelect })
      .then((user) => {
        if (user && !user.isBanned) res.locals.user = user;
        next();
      })
      .catch(() => next());
  } catch {
    next();
  }
}

/**
 * Gate an action behind a confirmed email address. Applied to "participate"
 * endpoints (posting, commenting, publishing) so an unverified signup can browse
 * but not contribute until they enter the code.
 *
 * INERT when email delivery isn't configured: if we can't send a code, we must
 * not block anyone on one. Existing users + OAuth signups are already verified,
 * so this only ever stops a brand-new email/password signup mid-onboarding.
 * Must run AFTER requireAuth.
 */
export async function requireVerifiedEmail(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = res.locals.user;
  if (!user) return next(unauth());
  const { isEmailConfigured } = await import("../lib/email");
  if (!isEmailConfigured()) return next();        // gate inert until SMTP is set
  if (user.emailVerifiedAt) return next();        // already confirmed
  return next(forbidden("Verify your email to do this. Check your inbox for the code.", "EMAIL_UNVERIFIED"));
}

/**
 * Gate an action to creators only. Blogs and polls are creator-authored content
 * — regular members cannot publish them. Access mirrors the Creator Studio gate
 * (admin-granted "active" status, auto-qualify eligibility, or already an active
 * creator); platform admins are always allowed. Must run AFTER requireAuth.
 */
export async function requireCreator(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = res.locals.user;
    if (!user) return next(unauth());
    if (user.role === "ADMIN") return next();
    const { getCreatorAccess } = await import("../modules/creator/creator.service");
    const access = await getCreatorAccess(user.id);
    if (!access.hasAccess) {
      return next(forbidden("Only creators can publish this. Apply for Creator access in Creator Studio."));
    }
    next();
  } catch (err) {
    next(err);
  }
}
