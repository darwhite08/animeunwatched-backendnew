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
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as { userId: string };
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: userSelect,
    });
    if (!user) return next(unauth());
    if (user.isBanned) return next(unauth("Your account has been suspended"));
    res.locals.user = user;
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
