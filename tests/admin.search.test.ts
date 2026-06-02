import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist-friendly: build the mock factory itself rather than capturing an outer var
vi.mock("../app/src/config/prisma", () => {
  const findManyMock = vi.fn(async () => []);
  return {
    prisma: {
      user:          { findMany: findManyMock },
      post:          { findMany: findManyMock },
      auditLog:      { findMany: findManyMock },
      featureFlag:   { findMany: findManyMock },
      adminSetting:  { findMany: findManyMock },
      adminRole:     { findMany: findManyMock },
    },
    __findManyMock: findManyMock,
  };
});

import * as prismaModule from "../app/src/config/prisma";
const findManyMock = (prismaModule as unknown as { __findManyMock: ReturnType<typeof vi.fn> }).__findManyMock;

import { globalSearch } from "../app/src/modules/admin/search.controller";

function makeReq(query: Record<string, string> = {}) {
  return { body: {}, params: {} as Record<string, string>, query, headers: {} as Record<string, unknown>, ip: "1.1.1.1" } as never;
}
function makeRes() {
  return { locals: { user: { id: "op-1" } }, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as never;
}

beforeEach(() => { findManyMock.mockClear() });

describe("global search", () => {
  it("returns empty results when q < 2 chars", async () => {
    const res = makeRes();
    await globalSearch(makeReq({ q: "x" }), res, vi.fn() as never);
    const data = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(data.results.users).toEqual([]);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("queries all 6 sources for a valid q", async () => {
    const res = makeRes();
    await globalSearch(makeReq({ q: "alice" }), res, vi.fn() as never);
    expect(findManyMock).toHaveBeenCalledTimes(6);   // users + posts + audit + flags + settings + roles
    const data = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(data.q).toBe("alice");
    expect(data.results).toHaveProperty("users");
    expect(data.results).toHaveProperty("audit");
    expect(data.results).toHaveProperty("flags");
  });

  it("trims whitespace before checking min-length", async () => {
    const res = makeRes();
    await globalSearch(makeReq({ q: "   " }), res, vi.fn() as never);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});
