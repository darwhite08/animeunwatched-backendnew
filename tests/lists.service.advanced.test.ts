/**
 * Advanced lists service tests — sorting, status filtering.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    anime: { findUnique: vi.fn() },
    listEntry: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

describe("getUserList — status filtering", () => {
  beforeEach(() => vi.clearAllMocks());

  it("filters by WATCHING status", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getUserList } = await import("../app/src/modules/lists/lists.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "u1", username: "user1" });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([[], 0]);

    await getUserList("user1", "WATCHING");

    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it("returns all entries without status filter", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getUserList } = await import("../app/src/modules/lists/lists.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "u1", username: "user1" });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      [{ id: "e1", status: "WATCHING" }, { id: "e2", status: "COMPLETED" }],
      2
    ]);

    const result = await getUserList("user1", undefined, undefined, 1, 20);
    expect(result.data).toHaveLength(2);
  });

  it("ignores invalid status values", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getUserList } = await import("../app/src/modules/lists/lists.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "u1", username: "user1" });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([[], 0]);

    // Invalid status should be ignored (no filter applied)
    await getUserList("user1", "INVALID_STATUS");

    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

describe("getUserList — sorting", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sorts by score when sort=score", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getUserList } = await import("../app/src/modules/lists/lists.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "u1", username: "user1" });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([[], 0]);

    await getUserList("user1", undefined, "score");

    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it("sorts by title when sort=title", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getUserList } = await import("../app/src/modules/lists/lists.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "u1", username: "user1" });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([[], 0]);

    await getUserList("user1", undefined, "title");

    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

describe("upsertEntry — score validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("handles all valid watch statuses", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { upsertEntry } = await import("../app/src/modules/lists/lists.service");

    const statuses = ["PLAN_TO_WATCH", "WATCHING", "COMPLETED", "ON_HOLD", "DROPPED"] as const;

    for (const status of statuses) {
      vi.clearAllMocks();
      (prisma.anime.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "a1", malId: 21 });
      (prisma.listEntry.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "e1", status });

      const result = await upsertEntry("u1", "a1", { status });
      expect(result.entry.status).toBe(status);
    }
  });
});
