import { Request, Response, NextFunction } from "express";
import { forbidden } from "../lib/errors";

export function requireAdmin(_req: Request, res: Response, next: NextFunction): void {
  if (res.locals.user?.role !== "ADMIN") return next(forbidden("Admin access required"));
  next();
}
