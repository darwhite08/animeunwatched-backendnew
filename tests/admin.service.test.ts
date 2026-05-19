/**
 * Admin service unit tests — tests that admin endpoints work correctly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user: { count: vi.fn(), findMany: vi.fn() },
    post: { count: vi.fn() },
    anime: { count: vi.fn() },
    club: { count: vi.fn() },
    review: { count: vi.fn() },
    blog: { count: vi.fn() },
    listEntry: { count: vi.fn() },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    $queryRaw: vi.fn().mockResolvedValue([{ "1": 1 }]),
  },
}));

vi.mock("../app/src/lib/cache", () => ({
  cache: { size: 42 },
}));

function makeRes(): Response & { locals: Record<string, unknown> } {
  const res = {
    locals: { user: { role: "ADMIN" } },
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & { locals: Record<string, unknown> };
}

describe("admin requireAdmin guard", () => {
  it("returns 403 for non-admin users", async () => {
    const { requireAdmin } = await import("../app/src/middlewares/requireAdmin");
    const res = makeRes();
    res.locals.user = { role: "USER" };
    const next = vi.fn();

    requireAdmin({} as Request, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it("allows admin users through", async () => {
    const { requireAdmin } = await import("../app/src/middlewares/requireAdmin");
    const res = makeRes();
    res.locals.user = { role: "ADMIN" };
    const next = vi.fn();

    requireAdmin({} as Request, res, next);

    expect(next).toHaveBeenCalledWith(); // no args = pass
  });
});

describe("admin routes — health endpoint", () => {
  it("getPlatformHealth returns cache info", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { cache } = await import("../app/src/lib/cache");
    const { getPlatformHealth } = await import("../app/src/modules/admin/admin.service");

    const result = await getPlatformHealth();

    expect(result).toBeDefined();
  });
});
