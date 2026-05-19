/**
 * Search controller validation tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    anime: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    post: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    blog: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    club: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    thread: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    review: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

function makeReq(query: Record<string, string> = {}): Request {
  return { query, params: {}, body: {}, headers: {} } as unknown as Request;
}

function makeRes(): Response & { locals: Record<string, unknown> } {
  const res = {
    locals: {},
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & { locals: Record<string, unknown> };
}

describe("search controller", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws 400 when q is missing", async () => {
    const { search } = await import("../app/src/modules/search/search.controller");
    const next = vi.fn();

    await search(makeReq({}), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("throws 400 when q is empty string", async () => {
    const { search } = await import("../app/src/modules/search/search.controller");
    const next = vi.fn();

    await search(makeReq({ q: "" }), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("returns results for valid q and type=anime", async () => {
    const { search } = await import("../app/src/modules/search/search.controller");
    const next = vi.fn();
    const res = makeRes();

    await search(makeReq({ q: "naruto", type: "anime" }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: [] }));
  });

  it("returns results for type=posts", async () => {
    const { search } = await import("../app/src/modules/search/search.controller");
    const res = makeRes();
    const next = vi.fn();

    await search(makeReq({ q: "theory", type: "posts" }), res, next);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns results for type=users", async () => {
    const { search } = await import("../app/src/modules/search/search.controller");
    const res = makeRes();
    const next = vi.fn();

    await search(makeReq({ q: "admin", type: "users" }), res, next);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns results for type=blogs", async () => {
    const { search } = await import("../app/src/modules/search/search.controller");
    const res = makeRes();
    const next = vi.fn();

    await search(makeReq({ q: "review", type: "blogs" }), res, next);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("defaults to type=anime when type is not provided", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { search } = await import("../app/src/modules/search/search.controller");
    const res = makeRes();
    const next = vi.fn();

    await search(makeReq({ q: "naruto" }), res, next);

    // Should have used anime search
    expect(prisma.anime.findMany).toHaveBeenCalled();
  });
});
