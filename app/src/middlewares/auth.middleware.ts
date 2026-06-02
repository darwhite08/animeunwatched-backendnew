import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { unauth } from "../lib/errors";
import { prisma } from "../config/prisma";

const userSelect = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  bio: true,
  avatarUrl: true,
  role: true,
  reputation: true,
  isBanned: true,
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
