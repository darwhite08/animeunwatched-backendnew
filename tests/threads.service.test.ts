/**
 * Threads service unit tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    thread: {
      findUnique: vi.fn(),
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

describe("threads.service — createClubThread", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent club", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { createClubThread } = await import("../app/src/modules/threads/threads.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(createClubThread("user-1", "non-existent", { title: "Thread Title Here", content: "Content here is long enough for the test to pass validation" }))
      .rejects.toThrow("Club not found");
  });

  it("throws FORBIDDEN if user is not a club member", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { createClubThread } = await import("../app/src/modules/threads/threads.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "club-1", slug: "my-club" });
    (prisma.clubMember.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(createClubThread("user-1", "my-club", { title: "Thread Title", content: "Content here is long enough for the validation check to pass" }))
      .rejects.toThrow("must be a member");
  });

  it("creates a thread for club member", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { createClubThread } = await import("../app/src/modules/threads/threads.service");

    (prisma.club.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "club-1", slug: "my-club" });
    (prisma.clubMember.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ userId: "user-1", role: "USER" });

    const mockThread = { id: "t1", title: "Great Thread", content: "Content here",
      author: { id: "user-1", username: "user1", displayName: "User", avatarUrl: null },
      _count: { replies: 0 } };
    (prisma.thread.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockThread);

    const result = await createClubThread("user-1", "my-club", { title: "Great Thread", content: "Content here" });
    expect(result.thread.title).toBe("Great Thread");
  });
});

describe("threads.service — createReply", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent thread", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { createReply } = await import("../app/src/modules/threads/threads.service");

    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(createReply("non-existent", "user-1", { content: "My reply here" }))
      .rejects.toThrow("Thread not found");
  });

  it("throws FORBIDDEN for locked thread", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { createReply } = await import("../app/src/modules/threads/threads.service");

    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "t1", isLocked: true });

    await expect(createReply("t1", "user-1", { content: "My reply here" }))
      .rejects.toThrow("locked");
  });

  it("throws BAD_REQUEST for parentId not in this thread", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { createReply } = await import("../app/src/modules/threads/threads.service");

    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "t1", isLocked: false });
    (prisma.threadReply.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "r1", threadId: "other-thread",  // Different thread!
    });

    await expect(createReply("t1", "user-1", { content: "My reply", parentId: "clxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }))
      .rejects.toThrow("does not belong to this thread");
  });

  it("creates a reply without parentId", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { createReply } = await import("../app/src/modules/threads/threads.service");

    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "t1", isLocked: false });
    const mockReply = { id: "r1", content: "My reply", threadId: "t1", authorId: "user-1",
      author: { id: "user-1", username: "user1", displayName: "User", avatarUrl: null } };
    (prisma.threadReply.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockReply);

    const result = await createReply("t1", "user-1", { content: "My reply" });
    expect(result.reply.content).toBe("My reply");
  });
});

describe("threads.service — update", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws FORBIDDEN if user is not author and not MOD/ADMIN", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { update } = await import("../app/src/modules/threads/threads.service");

    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "t1", authorId: "other-user",
    });

    await expect(update("t1", "user-1", "USER", { title: "New title" }))
      .rejects.toThrow("Not allowed to edit");
  });

  it("allows MOD to edit any thread", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { update } = await import("../app/src/modules/threads/threads.service");

    (prisma.thread.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "t1", authorId: "other-user" });
    (prisma.thread.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "t1", title: "Updated Title",
      author: { id: "mod-1", username: "mod", displayName: "Mod", avatarUrl: null },
      _count: { replies: 0 },
    });

    const result = await update("t1", "mod-1", "MOD", { title: "Updated Title" });
    expect(result.thread.title).toBe("Updated Title");
  });
});
