import type { Request, Response, NextFunction } from "express";
import { prisma } from "../../config/prisma";
import { badRequest, notFound, forbidden } from "../../lib/errors";
import { adminAudit, ipFromReq, uaFromReq } from "../../lib/adminAudit";
import { invalidatePermissionCache, getEffectivePermissions } from "../../lib/permissions";

export async function listPermissions(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.permission.findMany({
      orderBy: [{ resource: "asc" }, { action: "asc" }],
    });
    res.status(200).json({ data });
  } catch (err) { next(err); }
}

export async function listRoles(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await prisma.adminRole.findMany({
      orderBy: { name: "asc" },
      include: {
        permissions: { include: { permission: true } },
        _count:      { select: { users: true } },
      },
    });
    res.status(200).json({
      data: data.map(r => ({
        id: r.id, name: r.name, description: r.description, isSystem: r.isSystem,
        userCount:   r._count.users,
        permissions: r.permissions.map(p => ({ resource: p.permission.resource, action: p.permission.action })),
      })),
    });
  } catch (err) { next(err); }
}

export async function createRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const { name, description, permissions } = req.body as {
      name?: string; description?: string; permissions?: Array<{ resource: string; action: string }>;
    };
    if (!name || name.length < 2) throw badRequest("name required");
    const exists = await prisma.adminRole.findUnique({ where: { name } });
    if (exists) throw badRequest(`Role '${name}' already exists`);
    const role = await prisma.adminRole.create({
      data: { name, description: description ?? null, isSystem: false },
    });
    if (permissions?.length) {
      for (const p of permissions) {
        const perm = await prisma.permission.findUnique({
          where: { resource_action: { resource: p.resource, action: p.action } },
        });
        if (!perm) continue;
        await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
      }
    }
    await adminAudit({
      actorId, action: "role.create", targetType: "AdminRole", targetId: role.id,
      metadata: { name, permissions: permissions ?? [] },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ role });
  } catch (err) { next(err); }
}

export async function updateRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const roleId  = req.params.roleId as string;
    const role = await prisma.adminRole.findUnique({ where: { id: roleId } });
    if (!role) throw notFound("Role not found");

    const { description, permissions } = req.body as {
      description?: string;
      permissions?: Array<{ resource: string; action: string }>;
    };

    if (description !== undefined) {
      await prisma.adminRole.update({ where: { id: roleId }, data: { description } });
    }
    if (Array.isArray(permissions)) {
      // Replace the role's permission set
      await prisma.rolePermission.deleteMany({ where: { roleId } });
      for (const p of permissions) {
        const perm = await prisma.permission.findUnique({
          where: { resource_action: { resource: p.resource, action: p.action } },
        });
        if (!perm) continue;
        await prisma.rolePermission.create({ data: { roleId, permissionId: perm.id } });
      }
      // Invalidate cache for all users that hold this role
      const users = await prisma.userAdminRole.findMany({ where: { roleId }, select: { userId: true } });
      for (const u of users) invalidatePermissionCache(u.userId);
    }
    await adminAudit({
      actorId, action: "role.update", targetType: "AdminRole", targetId: roleId,
      metadata: { description, permissions },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}

export async function deleteRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const roleId  = req.params.roleId as string;
    const role = await prisma.adminRole.findUnique({ where: { id: roleId } });
    if (!role) throw notFound("Role not found");
    if (role.isSystem) throw forbidden("Cannot delete a system role");
    const inUse = await prisma.userAdminRole.count({ where: { roleId } });
    if (inUse > 0) throw badRequest(`Role assigned to ${inUse} users — revoke first`);
    await prisma.adminRole.delete({ where: { id: roleId } });
    await adminAudit({
      actorId, action: "role.delete", targetType: "AdminRole", targetId: roleId,
      metadata: { name: role.name }, ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}

export async function grantUserRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const userId  = req.params.userId as string;
    const { roleName } = req.body as { roleName?: string };
    if (!roleName) throw badRequest("roleName required");
    const role = await prisma.adminRole.findUnique({ where: { name: roleName } });
    if (!role) throw notFound("Role not found");
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound("User not found");
    await prisma.userAdminRole.upsert({
      where:  { userId_roleId: { userId, roleId: role.id } },
      update: {},
      create: { userId, roleId: role.id, grantedBy: actorId },
    });
    invalidatePermissionCache(userId);
    await adminAudit({
      actorId, action: "role.grant", targetType: "User", targetId: userId,
      metadata: { roleName }, ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}

export async function revokeUserRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = res.locals.user?.id as string;
    const userId  = req.params.userId as string;
    const { roleName } = req.body as { roleName?: string };
    if (!roleName) throw badRequest("roleName required");
    const role = await prisma.adminRole.findUnique({ where: { name: roleName } });
    if (!role) throw notFound("Role not found");
    if (userId === actorId && role.name === "SuperAdmin") {
      throw badRequest("Cannot revoke your own SuperAdmin role");
    }
    await prisma.userAdminRole.deleteMany({ where: { userId, roleId: role.id } });
    invalidatePermissionCache(userId);
    await adminAudit({
      actorId, action: "role.revoke", targetType: "User", targetId: userId,
      metadata: { roleName }, ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ ok: true });
  } catch (err) { next(err); }
}

export async function getUserRoles(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.params.userId as string;
    const rows = await prisma.userAdminRole.findMany({
      where:   { userId },
      include: { role: true },
    });
    const perms = Array.from(await getEffectivePermissions(userId));
    res.status(200).json({
      roles:       rows.map(r => ({ id: r.role.id, name: r.role.name, description: r.role.description })),
      permissions: perms,
    });
  } catch (err) { next(err); }
}

export async function diffRoles(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const a = req.query.a as string | undefined;
    const b = req.query.b as string | undefined;
    if (!a || !b) throw badRequest("a and b role IDs required");
    const [ra, rb] = await Promise.all([
      prisma.adminRole.findUnique({ where: { id: a }, include: { permissions: { include: { permission: true } } } }),
      prisma.adminRole.findUnique({ where: { id: b }, include: { permissions: { include: { permission: true } } } }),
    ]);
    if (!ra || !rb) throw notFound("Role not found");
    const setA = new Set(ra.permissions.map(p => `${p.permission.resource}:${p.permission.action}`));
    const setB = new Set(rb.permissions.map(p => `${p.permission.resource}:${p.permission.action}`));
    const onlyA = [...setA].filter(p => !setB.has(p));
    const onlyB = [...setB].filter(p => !setA.has(p));
    const both  = [...setA].filter(p => setB.has(p));
    res.status(200).json({ a: ra.name, b: rb.name, onlyA, onlyB, both });
  } catch (err) { next(err); }
}
