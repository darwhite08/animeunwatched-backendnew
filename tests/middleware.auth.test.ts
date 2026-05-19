/**
 * Auth middleware unit tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// Set up env before importing the middleware
process.env.JWT_ACCESS_SECRET  = "test-access-secret-min-32-chars-long!";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-min-32-chars-long!";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

function makeReq(authHeader?: string): Request {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
    cookies: {},
    body: {},
    params: {},
    query: {},
  } as unknown as Request;
}

function makeRes(): Response & { locals: Record<string, unknown> } {
  const res = {
    locals: {},
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & { locals: Record<string, unknown> };
}

describe("requireAuth middleware", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls next(unauth) when no Authorization header", async () => {
    const { requireAuth } = await import("../app/src/middlewares/auth.middleware");
    const next = vi.fn();

    await requireAuth(makeReq(), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it("calls next(unauth) when header doesn't start with Bearer", async () => {
    const { requireAuth } = await import("../app/src/middlewares/auth.middleware");
    const next = vi.fn();

    await requireAuth(makeReq("Basic abc123"), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it("calls next(unauth) for invalid JWT", async () => {
    const { requireAuth } = await import("../app/src/middlewares/auth.middleware");
    const next = vi.fn();

    await requireAuth(makeReq("Bearer invalid-jwt-token"), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it("calls next(unauth) when user not found in DB", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { requireAuth } = await import("../app/src/middlewares/auth.middleware");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const token = jwt.sign({ userId: "user-1" }, process.env.JWT_ACCESS_SECRET!);
    const next = vi.fn();

    await requireAuth(makeReq(`Bearer ${token}`), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it("calls next(unauth) when user is banned", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { requireAuth } = await import("../app/src/middlewares/auth.middleware");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "user-1", email: "banned@example.com", username: "banned",
      displayName: "Banned User", bio: null, avatarUrl: null,
      role: "USER", reputation: 0, isBanned: true, createdAt: new Date(),
    });

    const token = jwt.sign({ userId: "user-1" }, process.env.JWT_ACCESS_SECRET!);
    const next = vi.fn();

    await requireAuth(makeReq(`Bearer ${token}`), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  it("sets res.locals.user and calls next() for valid auth", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { requireAuth } = await import("../app/src/middlewares/auth.middleware");

    const mockUser = {
      id: "user-1", email: "user@example.com", username: "user1",
      displayName: "User", bio: null, avatarUrl: null,
      role: "USER", reputation: 0, isBanned: false, createdAt: new Date(),
    };
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockUser);

    const token = jwt.sign({ userId: "user-1" }, process.env.JWT_ACCESS_SECRET!);
    const next = vi.fn();
    const res = makeRes();

    await requireAuth(makeReq(`Bearer ${token}`), res, next);

    expect(next).toHaveBeenCalledWith(); // called with no args = success
    expect(res.locals.user).toEqual(mockUser);
  });
});

describe("requireAdmin middleware", () => {
  it("calls next(forbidden) for non-admin users", async () => {
    const { requireAdmin } = await import("../app/src/middlewares/requireAdmin");
    const next = vi.fn();
    const res = makeRes();
    res.locals.user = { role: "USER" };

    requireAdmin({} as Request, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  it("calls next() for ADMIN users", async () => {
    const { requireAdmin } = await import("../app/src/middlewares/requireAdmin");
    const next = vi.fn();
    const res = makeRes();
    res.locals.user = { role: "ADMIN" };

    requireAdmin({} as Request, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it("calls next(forbidden) for MOD users (not admin)", async () => {
    const { requireAdmin } = await import("../app/src/middlewares/requireAdmin");
    const next = vi.fn();
    const res = makeRes();
    res.locals.user = { role: "MOD" };

    requireAdmin({} as Request, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });
});
