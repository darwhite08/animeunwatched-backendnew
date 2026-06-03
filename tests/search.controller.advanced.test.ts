/**
 * Search controller advanced tests — all type branches.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const defaultMock = () => ({
  findMany: vi.fn().mockResolvedValue([]),
  count: vi.fn().mockResolvedValue(0),
  findUnique: vi.fn().mockResolvedValue(null),
});

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    anime: defaultMock(),
    post: defaultMock(),
    user: defaultMock(),
    blog: defaultMock(),
    club: defaultMock(),
    thread: defaultMock(),
    review: defaultMock(),
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

function makeReq(query: Record<string, string> = {}): Request {
  return { query, params: {}, body: {}, headers: {} } as unknown as Request;
}

function makeRes(): Response & { locals: Record<string, unknown> } {
  return {
    locals: {},
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response & { locals: Record<string, unknown> };
}

describe("search controller — type branches", () => {
  beforeEach(() => vi.clearAllMocks());

  const types = ["anime", "posts", "users", "blogs", "clubs", "threads", "reviews"] as const;

  for (const type of types) {
    it(`handles type=${type} with valid query`, async () => {
      const { search } = await import("../app/src/modules/search/search.controller");
      const res = makeRes();
      const next = vi.fn();

      await search(makeReq({ q: "test", type }), res, next);

      // Some types (reviews) return via res.json directly without res.status(200)
      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalled();
    });
  }

  it("uses default type=anime when type not specified", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { search } = await import("../app/src/modules/search/search.controller");
    const res = makeRes();

    await search(makeReq({ q: "naruto" }), res, vi.fn());

    expect(prisma.anime.findMany).toHaveBeenCalled();
    expect(prisma.post.findMany).not.toHaveBeenCalled();
  });

  it("over-fetches candidates and paginates in JS for relevance ranking", async () => {
    // As of trending-v2 the anime search no longer paginates in SQL — it
    // pulls up to 200 candidates so the multi-signal relevance ranker can
    // see them all before slicing. See lib/ranking.ts + search.controller.
    const { prisma } = await import("../app/src/config/prisma");
    const { search } = await import("../app/src/modules/search/search.controller");
    const res = makeRes();

    await search(makeReq({ q: "naruto", type: "anime", page: "2", limit: "10" }), res, vi.fn());

    expect(prisma.anime.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 })
    );
    // SQL should NOT have been called with a `skip` — pagination is JS-side now.
    const callArg = (prisma.anime.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArg).not.toHaveProperty("skip")
  });

  it("returns 400 for empty query", async () => {
    const { search } = await import("../app/src/modules/search/search.controller");
    const next = vi.fn();

    await search(makeReq({ q: "   " }), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });
});

describe("suggestions controller", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns anime and user suggestions", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { suggestions } = await import("../app/src/modules/search/search.controller");

    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      [{ malId: 21, title: "One Piece", imageUrl: null }],
      [{ username: "luffy", displayName: "Monkey D. Luffy" }],
    ]);

    const res = makeRes();
    await suggestions(makeReq({ q: "one" }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ anime: expect.any(Array) }));
  });

  it("returns 400 for empty suggestions query", async () => {
    const { suggestions } = await import("../app/src/modules/search/search.controller");
    const next = vi.fn();

    await suggestions(makeReq({ q: "" }), makeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });
});
