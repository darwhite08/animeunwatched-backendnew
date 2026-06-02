import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

const mockUserAdminRoles: Array<{ userId: string; role: { name: string; permissions: Array<{ permission: { resource: string; action: string } }> } }> = [];

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    userAdminRole: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        mockUserAdminRoles.filter(r => r.userId === where.userId)),
    },
  },
}));

import { hasPermission, requirePermission, invalidatePermissionCache } from "../app/src/lib/permissions";

beforeEach(() => {
  mockUserAdminRoles.length = 0;
  invalidatePermissionCache();
});

describe("permissions", () => {
  it("hasPermission returns false for user with no roles", async () => {
    expect(await hasPermission("u1", "users", "ban")).toBe(false);
  });

  it("SuperAdmin wildcard grants every permission", async () => {
    mockUserAdminRoles.push({ userId: "u1", role: { name: "SuperAdmin", permissions: [] } });
    expect(await hasPermission("u1", "users", "ban")).toBe(true);
    expect(await hasPermission("u1", "anything", "at_all")).toBe(true);
  });

  it("non-Super role grants only listed permissions", async () => {
    mockUserAdminRoles.push({
      userId: "u2",
      role: { name: "Support", permissions: [
        { permission: { resource: "users", action: "read" } },
        { permission: { resource: "audit", action: "read" } },
      ] },
    });
    expect(await hasPermission("u2", "users", "read")).toBe(true);
    expect(await hasPermission("u2", "users", "ban")).toBe(false);
    expect(await hasPermission("u2", "audit", "read")).toBe(true);
  });

  it("requirePermission middleware calls next() with no args on grant", async () => {
    mockUserAdminRoles.push({ userId: "u3", role: { name: "SuperAdmin", permissions: [] } });
    const res = { locals: { user: { id: "u3" } } } as unknown as Response;
    const next = vi.fn();
    await requirePermission("users", "ban")({} as Request, res, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeUndefined();
  });

  it("requirePermission middleware calls next(forbidden) on deny", async () => {
    const res = { locals: { user: { id: "uX" } } } as unknown as Response;
    const next = vi.fn();
    await requirePermission("users", "ban")({} as Request, res, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Missing permission");
  });

  it("requirePermission middleware calls next(unauth) when no user in locals", async () => {
    const res = { locals: {} } as unknown as Response;
    const next = vi.fn();
    await requirePermission("users", "ban")({} as Request, res, next as NextFunction);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});
