import { describe, it, expect, vi, beforeEach } from "vitest";

const roles = new Map<string, { id: string; name: string; description: string | null; isSystem: boolean }>();
const perms = new Map<string, { id: string; resource: string; action: string }>();
const rolePerms: Array<{ roleId: string; permissionId: string }> = [];
const userRoles: Array<{ userId: string; roleId: string }> = [];
let auditCalls: Array<{ action: string }> = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    permission: {
      findMany:  vi.fn(async () => Array.from(perms.values())),
      findUnique: vi.fn(async ({ where }: { where: { resource_action: { resource: string; action: string } } }) =>
        Array.from(perms.values()).find(p => p.resource === where.resource_action.resource && p.action === where.resource_action.action) ?? null),
    },
    adminRole: {
      findMany: vi.fn(async () =>
        Array.from(roles.values()).map(r => ({
          ...r,
          permissions: rolePerms.filter(rp => rp.roleId === r.id).map(rp => ({ permission: perms.get(rp.permissionId) })),
          _count: { users: userRoles.filter(u => u.roleId === r.id).length },
        }))),
      findUnique: vi.fn(async ({ where, include }: { where: { id?: string; name?: string }; include?: unknown }) => {
        const r = where.id ? roles.get(where.id) : Array.from(roles.values()).find(x => x.name === where.name);
        if (!r) return null;
        if (include) return { ...r, permissions: rolePerms.filter(rp => rp.roleId === r.id).map(rp => ({ permission: perms.get(rp.permissionId) })) };
        return r;
      }),
      create: vi.fn(async ({ data }: { data: { name: string; description: string | null; isSystem: boolean } }) => {
        const r = { id: `r-${roles.size + 1}`, ...data };
        roles.set(r.id, r);
        return r;
      }),
      update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = roles.get(id); if (!r) return null;
        Object.assign(r, data); return r;
      }),
      delete: vi.fn(async ({ where: { id } }: { where: { id: string } }) => { roles.delete(id); return null }),
    },
    rolePermission: {
      create:     vi.fn(async ({ data }: { data: { roleId: string; permissionId: string } }) => { rolePerms.push(data); return data }),
      deleteMany: vi.fn(async ({ where: { roleId } }: { where: { roleId: string } }) => {
        const before = rolePerms.length;
        for (let i = rolePerms.length - 1; i >= 0; i--) if (rolePerms[i].roleId === roleId) rolePerms.splice(i, 1);
        return { count: before - rolePerms.length };
      }),
    },
    userAdminRole: {
      findMany: vi.fn(async ({ where, include }: { where: { roleId?: string; userId?: string }; include?: unknown }) => {
        const filtered = userRoles.filter(u => (where.roleId ? u.roleId === where.roleId : true) && (where.userId ? u.userId === where.userId : true));
        if (include) return filtered.map(u => ({ userId: u.userId, role: roles.get(u.roleId) }));
        return filtered;
      }),
      upsert: vi.fn(async ({ where: { userId_roleId } }: { where: { userId_roleId: { userId: string; roleId: string } } }) => {
        const exists = userRoles.find(u => u.userId === userId_roleId.userId && u.roleId === userId_roleId.roleId);
        if (!exists) userRoles.push(userId_roleId);
        return userId_roleId;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { userId: string; roleId: string } }) => {
        const before = userRoles.length;
        for (let i = userRoles.length - 1; i >= 0; i--)
          if (userRoles[i].userId === where.userId && userRoles[i].roleId === where.roleId) userRoles.splice(i, 1);
        return { count: before - userRoles.length };
      }),
      count: vi.fn(async ({ where: { roleId } }: { where: { roleId: string } }) =>
        userRoles.filter(u => u.roleId === roleId).length),
    },
    user: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => ({ id, role: "USER", username: "x", email: "x@y" })),
    },
    auditLog: {
      findFirst: vi.fn(async () => null),
      create:    vi.fn(async ({ data }: { data: { action: string } }) => { auditCalls.push({ action: data.action }); return data }),
    },
  },
}));

import { createRole, updateRole, deleteRole, grantUserRole, revokeUserRole, diffRoles, listRoles, listPermissions } from "../app/src/modules/admin/roles.controller";

function makeReq(body: Record<string, unknown> = {}, params: Record<string, string> = {}, query: Record<string, string> = {}) {
  return { body, params, query, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return {
    locals: { user: { id: "op-1" } },
    status: vi.fn().mockReturnThis(),
    json:   vi.fn().mockReturnThis(),
  } as never;
}

beforeEach(() => {
  roles.clear(); perms.clear(); rolePerms.length = 0; userRoles.length = 0; auditCalls = [];
  perms.set("p1", { id: "p1", resource: "users", action: "read" });
  perms.set("p2", { id: "p2", resource: "users", action: "ban" });
});

describe("roles controller", () => {
  it("createRole rejects too-short name", async () => {
    const next = vi.fn();
    await createRole(makeReq({ name: "x" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/name required/);
  });

  it("createRole rejects duplicates", async () => {
    roles.set("r1", { id: "r1", name: "Dup", description: null, isSystem: false });
    const next = vi.fn();
    await createRole(makeReq({ name: "Dup" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/already exists/);
  });

  it("createRole creates with permission set", async () => {
    await createRole(makeReq({ name: "Mod", permissions: [{ resource: "users", action: "read" }] }), makeRes(), vi.fn() as never);
    expect(roles.size).toBe(1);
    expect(rolePerms.length).toBe(1);
    expect(auditCalls.find(a => a.action === "role.create")).toBeDefined();
  });

  it("updateRole replaces permission set", async () => {
    roles.set("r1", { id: "r1", name: "Mod", description: null, isSystem: false });
    rolePerms.push({ roleId: "r1", permissionId: "p1" });
    await updateRole(makeReq({ permissions: [{ resource: "users", action: "ban" }] }, { roleId: "r1" }), makeRes(), vi.fn() as never);
    expect(rolePerms).toEqual([{ roleId: "r1", permissionId: "p2" }]);
  });

  it("deleteRole rejects system roles", async () => {
    roles.set("r1", { id: "r1", name: "SuperAdmin", description: null, isSystem: true });
    const next = vi.fn();
    await deleteRole(makeReq({}, { roleId: "r1" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/system role/);
  });

  it("deleteRole rejects when users still hold it", async () => {
    roles.set("r1", { id: "r1", name: "X", description: null, isSystem: false });
    userRoles.push({ userId: "u1", roleId: "r1" });
    const next = vi.fn();
    await deleteRole(makeReq({}, { roleId: "r1" }), makeRes(), next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/assigned/);
  });

  it("grantUserRole inserts UserAdminRole", async () => {
    roles.set("r1", { id: "r1", name: "Mod", description: null, isSystem: false });
    await grantUserRole(makeReq({ roleName: "Mod" }, { userId: "u1" }), makeRes(), vi.fn() as never);
    expect(userRoles).toContainEqual({ userId: "u1", roleId: "r1" });
    expect(auditCalls.find(a => a.action === "role.grant")).toBeDefined();
  });

  it("revokeUserRole blocks self-revoke of SuperAdmin", async () => {
    roles.set("sa", { id: "sa", name: "SuperAdmin", description: null, isSystem: true });
    const next = vi.fn();
    const res = { locals: { user: { id: "op-1" } }, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as never;
    await revokeUserRole(makeReq({ roleName: "SuperAdmin" }, { userId: "op-1" }), res, next as never);
    expect((next.mock.calls[0][0] as Error).message).toMatch(/Cannot revoke your own/);
  });

  it("diffRoles returns onlyA / onlyB / both", async () => {
    roles.set("a", { id: "a", name: "A", description: null, isSystem: false });
    roles.set("b", { id: "b", name: "B", description: null, isSystem: false });
    rolePerms.push({ roleId: "a", permissionId: "p1" }); // users:read
    rolePerms.push({ roleId: "a", permissionId: "p2" }); // users:ban
    rolePerms.push({ roleId: "b", permissionId: "p1" }); // users:read
    const res = makeRes();
    await diffRoles(makeReq({}, {}, { a: "a", b: "b" }), res, vi.fn() as never);
    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.onlyA).toEqual(["users:ban"]);
    expect(call.onlyB).toEqual([]);
    expect(call.both).toEqual(["users:read"]);
  });

  it("listRoles + listPermissions return shapes", async () => {
    roles.set("a", { id: "a", name: "A", description: null, isSystem: false });
    const res1 = makeRes(); await listRoles(makeReq(), res1, vi.fn() as never);
    expect((res1.json as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toHaveLength(1);
    const res2 = makeRes(); await listPermissions(makeReq(), res2, vi.fn() as never);
    expect((res2.json as ReturnType<typeof vi.fn>).mock.calls[0][0].data).toHaveLength(2);
  });
});
