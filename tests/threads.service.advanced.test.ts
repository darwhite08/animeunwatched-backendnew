/**
 * Advanced threads service tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    thread: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    threadReply: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    club: { findUnique: vi.fn() },
    clubMember: { findUnique: vi.fn() },
    anime: { findUnique: vi.fn() },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

const authorSelect = {
  id: "u1", username: "user1", displayName: "User", avatarUrl: null,
};

describe("threads.service — getById", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent thread", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getById } = await import("../app/src/modules/threads/threads.service");

    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(getById("non-existent")).rejects.toThrow("Thread not found");
  });

  it("returns thread data for valid id", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getById } = await import("../app/src/modules/threads/threads.service");

    const mockThread = {
      id: "t1", title: "Great Thread", content: "Content",
      author: authorSelect, _count: { replies: 5 },
    };
    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockThread);

    const result = await getById("t1");
    expect(result.thread.title).toBe("Great Thread");
    expect(result.thread._count.replies).toBe(5);
  });
});

describe("threads.service — getReplies", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent thread", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getReplies } = await import("../app/src/modules/threads/threads.service");

    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(getReplies("non-existent")).rejects.toThrow("Thread not found");
  });

  it("returns paginated replies", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getReplies } = await import("../app/src/modules/threads/threads.service");

    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "t1" });
    const mockReplies = [
      { id: "r1", content: "Reply 1", author: authorSelect },
      { id: "r2", content: "Reply 2", author: authorSelect },
    ];
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockReplies, 2]);

    const result = await getReplies("t1", 1, 50);
    expect(result.data).toHaveLength(2);
    expect(result.meta.total).toBe(2);
  });
});

describe("threads.service — createAnimeThread", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent anime", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { createAnimeThread } = await import("../app/src/modules/threads/threads.service");

    (prisma.anime.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(createAnimeThread("u1", 99999, {
      title: "Discussion Thread", content: "Content for the thread here"
    })).rejects.toThrow("Anime not found");
  });

  it("creates thread for existing anime", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { createAnimeThread } = await import("../app/src/modules/threads/threads.service");

    (prisma.anime.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "a1", malId: 21 });
    const mockThread = { id: "t1", title: "Discussion Thread", content: "Content",
      author: authorSelect, _count: { replies: 0 } };
    (prisma.thread.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockThread);

    const result = await createAnimeThread("u1", 21, {
      title: "Discussion Thread", content: "Content for the thread here"
    });
    expect(result.thread.title).toBe("Discussion Thread");
  });
});

describe("threads.service — deleteThread", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent thread", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { deleteThread } = await import("../app/src/modules/threads/threads.service");

    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(deleteThread("non-existent", "u1", "USER")).rejects.toThrow("Thread not found");
  });

  it("throws FORBIDDEN for non-author non-mod", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { deleteThread } = await import("../app/src/modules/threads/threads.service");

    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "t1", authorId: "other-user",
    });

    await expect(deleteThread("t1", "u1", "USER")).rejects.toThrow("Not allowed");
  });

  it("allows ADMIN to delete any thread", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { deleteThread } = await import("../app/src/modules/threads/threads.service");

    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "t1", authorId: "other-user",
    });
    (prisma.thread.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    await expect(deleteThread("t1", "admin-user", "ADMIN")).resolves.not.toThrow();
  });
});
