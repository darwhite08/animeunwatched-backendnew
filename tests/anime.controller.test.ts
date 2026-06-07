/**
 * Anime controller input validation tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { HttpError } from "../app/src/lib/errors";

// Mock service so no DB is needed
vi.mock("../app/src/modules/anime/anime.service", () => ({
  getById: vi.fn().mockResolvedValue({ anime: { malId: 1, title: "Test" } }),
  getBySlug: vi.fn().mockResolvedValue({ anime: { malId: 1, title: "Test" } }),
  browse: vi.fn().mockResolvedValue({ data: [], meta: { total: 0, page: 1, limit: 20, pages: 0 } }),
  searchWithFallback: vi.fn().mockResolvedValue([]),
  getSeasonal: vi.fn().mockResolvedValue({ data: [], meta: {} }),
  getTrending: vi.fn().mockResolvedValue([]),
  getSimilar: vi.fn().mockResolvedValue([]),
}));

vi.mock("../app/src/modules/anime/anime.schema", () => ({
  browseQuerySchema: { parse: (q: unknown) => q },
}));

function makeRes(): Response {
  const res: Partial<Response> & { locals: Record<string, unknown> } = {
    locals: {},
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

function makeReq(params: Record<string, string> = {}, query: Record<string, string> = {}): Request {
  return { params, query, headers: {}, body: {} } as unknown as Request;
}

describe("anime controller — malId validation", () => {
  let ctrl: typeof import("../app/src/modules/anime/anime.controller");

  beforeEach(async () => {
    ctrl = await import("../app/src/modules/anime/anime.controller");
  });

  it("getById: routes non-numeric param to slug lookup", async () => {
    const next = vi.fn();
    const service = await import("../app/src/modules/anime/anime.service");
    await ctrl.getById(makeReq({ malId: "fullmetal-alchemist-brotherhood" }), makeRes(), next);
    expect(next).not.toHaveBeenCalled();
    expect(service.getBySlug).toHaveBeenCalledWith("fullmetal-alchemist-brotherhood", undefined);
    expect(service.getById).not.toHaveBeenCalled();
  });

  it("getById: throws 400 for 0", async () => {
    const next = vi.fn();
    await ctrl.getById(makeReq({ malId: "0" }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("getById: accepts valid positive integer", async () => {
    const next = vi.fn();
    const res = makeRes();
    await ctrl.getById(makeReq({ malId: "21" }), res, next);
    expect(next).not.toHaveBeenCalled();
  });

  it("getSeasonal: throws 400 for invalid season", async () => {
    const next = vi.fn();
    await ctrl.getSeasonal(makeReq({ year: "2024", season: "monsoon" }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("getSeasonal: accepts valid season and year", async () => {
    const next = vi.fn();
    const res = makeRes();
    await ctrl.getSeasonal(makeReq({ year: "2024", season: "spring" }), res, next);
    expect(next).not.toHaveBeenCalled();
  });

  it("getSeasonal: throws 400 for invalid year string", async () => {
    const next = vi.fn();
    await ctrl.getSeasonal(makeReq({ year: "notayear", season: "fall" }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("search: throws 400 for empty query", async () => {
    const next = vi.fn();
    await ctrl.search(makeReq({}, { q: "" }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("search: accepts valid query string", async () => {
    const next = vi.fn();
    const res = makeRes();
    await ctrl.search(makeReq({}, { q: "naruto" }), res, next);
    expect(next).not.toHaveBeenCalled();
  });

  it("getTrending: caps limit at 100", async () => {
    const { getTrending: svc } = await import("../app/src/modules/anime/anime.service");
    const next = vi.fn();
    const res = makeRes();
    await ctrl.getTrending(makeReq({}, { limit: "99999" }), res, next);
    // Should be called with capped limit
    expect(svc).toHaveBeenCalledWith(100);
  });
});
