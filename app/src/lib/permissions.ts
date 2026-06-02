import type { Request, Response, NextFunction } from "express";
import { prisma } from "../config/prisma";
import { forbidden, unauth } from "./errors";

/**
 * Fine-grained admin authorization on top of the coarse User.role enum.
 *
 *   User.role=ADMIN        → can ENTER the admin surface (requireAdmin middleware)
 *   UserAdminRole → AdminRole → Permission(resource, action) → can DO X
 *
 * The two layers compose: every admin route still passes requireAuth + requireAdmin,
 * then individual handlers may call requirePermission("users", "suspend").
 *
 * For SuperAdmin (and only SuperAdmin), all permission checks pass automatically.
 */

const cache = new Map<string, { set: Set<string>; expiresAt: number }>();
const TTL_MS = 60_000;

export async function getEffectivePermissions(userId: string): Promise<Set<string>> {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.set;

  const roles = await prisma.userAdminRole.findMany({
    where:   { userId },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });

  const set = new Set<string>();
  for (const r of roles) {
    if (r.role.name === "SuperAdmin") set.add("*");
    for (const rp of r.role.permissions) {
      set.add(`${rp.permission.resource}:${rp.permission.action}`);
    }
  }
  cache.set(userId, { set, expiresAt: Date.now() + TTL_MS });
  return set;
}

export function invalidatePermissionCache(userId?: string): void {
  if (userId) cache.delete(userId); else cache.clear();
}

export async function hasPermission(userId: string, resource: string, action: string): Promise<boolean> {
  const set = await getEffectivePermissions(userId);
  return set.has("*") || set.has(`${resource}:${action}`);
}

/**
 * Express middleware. Use AFTER requireAuth + requireAdmin.
 *   adminRouter.post("/users/:id/role", requirePermission("users", "role"), ctrl.setRole)
 */
export function requirePermission(resource: string, action: string) {
  return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = res.locals.user?.id as string | undefined;
    if (!userId) return next(unauth("Authentication required"));
    if (await hasPermission(userId, resource, action)) return next();
    return next(forbidden(`Missing permission: ${resource}:${action}`));
  };
}

/**
 * Combined guard for endpoints that require BOTH a permission AND a recent
 * step-up token (for highest-risk actions like role grants, kill switches).
 */
export function requirePermissionWithStepUp(resource: string, action: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = res.locals.user?.id as string | undefined;
    if (!userId) return next(unauth("Authentication required"));
    if (!(await hasPermission(userId, resource, action))) {
      return next(forbidden(`Missing permission: ${resource}:${action}`));
    }
    // Step-up token is presented via X-StepUp-Token header
    const stepUpToken = req.header("x-stepup-token");
    if (!stepUpToken) return next(forbidden("STEPUP_REQUIRED"));
    const { consumeStepUpToken } = await import("./stepup");
    const ok = await consumeStepUpToken(userId, stepUpToken, `${resource}:${action}`);
    if (!ok) return next(forbidden("STEPUP_INVALID"));
    next();
  };
}
