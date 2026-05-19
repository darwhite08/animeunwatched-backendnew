/**
 * Pagination helper unit tests.
 */
import { describe, it, expect } from "vitest";

// Replicate the paginate/meta logic used across services
function paginate(page: number, limit: number) {
  return { skip: (page - 1) * limit, take: limit };
}
function buildMeta(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.ceil(total / limit) };
}

describe("paginate helper", () => {
  it("page 1, limit 20 → skip 0, take 20", () => {
    expect(paginate(1, 20)).toEqual({ skip: 0, take: 20 });
  });

  it("page 2, limit 20 → skip 20, take 20", () => {
    expect(paginate(2, 20)).toEqual({ skip: 20, take: 20 });
  });

  it("page 5, limit 10 → skip 40, take 10", () => {
    expect(paginate(5, 10)).toEqual({ skip: 40, take: 10 });
  });
});

describe("buildMeta helper", () => {
  it("calculates correct total pages", () => {
    expect(buildMeta(100, 1, 20).pages).toBe(5);
  });

  it("rounds up for incomplete last page", () => {
    expect(buildMeta(101, 1, 20).pages).toBe(6);
  });

  it("returns 0 pages for 0 total", () => {
    expect(buildMeta(0, 1, 20).pages).toBe(0);
  });

  it("returns all fields", () => {
    expect(buildMeta(50, 3, 10)).toEqual({ total: 50, page: 3, limit: 10, pages: 5 });
  });
});
