/**
 * Lists service unit tests.
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

describe("getUserList", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND if user does not exist", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getUserList } = await import("../app/src/modules/lists/lists.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(getUserList("ghostuser")).rejects.toThrow("User not found");
  });

  it("returns empty list for user with no entries", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getUserList } = await import("../app/src/modules/lists/lists.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "u1", username: "user1" });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([[], 0]);

    const result = await getUserList("user1");
    expect(result.data).toEqual([]);
    expect(result.meta.total).toBe(0);
  });

  it("returns paginated meta correctly", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getUserList } = await import("../app/src/modules/lists/lists.service");

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "u1", username: "user1" });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      Array(20).fill({ id: "e1" }), // 20 entries returned
      55, // 55 total
    ]);

    const result = await getUserList("user1", undefined, undefined, 1, 20);
    expect(result.meta.total).toBe(55);
    expect(result.meta.pages).toBe(3); // ceil(55/20) = 3
    expect(result.meta.page).toBe(1);
    expect(result.meta.limit).toBe(20);
  });
});

describe("upsertEntry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND if anime doesn't exist", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { upsertEntry } = await import("../app/src/modules/lists/lists.service");

    (prisma.anime.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(upsertEntry("user-1", "anime-id-1", { status: "WATCHING" })).rejects.toThrow("Anime not found");
  });

  it("upserts an entry successfully", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { upsertEntry } = await import("../app/src/modules/lists/lists.service");

    (prisma.anime.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "anime-1", malId: 21 });
    (prisma.listEntry.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "entry-1", userId: "user-1", animeId: "anime-1", status: "WATCHING",
      score: null, episodesSeen: 0, notes: null,
    });

    const result = await upsertEntry("user-1", "anime-1", { status: "WATCHING" });
    expect(result.entry.status).toBe("WATCHING");
  });
});

describe("deleteEntry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND if entry doesn't exist", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { deleteEntry } = await import("../app/src/modules/lists/lists.service");

    (prisma.listEntry.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(deleteEntry("user-1", "anime-1")).rejects.toThrow("List entry not found");
  });

  it("deletes an existing entry", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { deleteEntry } = await import("../app/src/modules/lists/lists.service");

    (prisma.listEntry.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "entry-1", userId: "user-1", animeId: "anime-1",
    });
    (prisma.listEntry.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    await expect(deleteEntry("user-1", "anime-1")).resolves.not.toThrow();
  });
});
