/**
 * Posts service unit tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPostInclude = {
  author: { id: "u1", username: "user1", displayName: "User One", avatarUrl: null },
  anime: null,
  _count: { likes: 0, comments: 0 },
};

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    post: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    postLike: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
    },
    follow: {
      findMany: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("../app/src/lib/reputation", () => ({
  addReputation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../app/src/lib/notify", () => ({
  createNotification: vi.fn().mockResolvedValue({}),
  NotificationType: { MENTION: "mention" },
}));

describe("posts.service — likePost", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent or deleted post", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { likePost } = await import("../app/src/modules/posts/posts.service");

    (prisma.post.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(likePost("u1", "nonexistent")).rejects.toThrow("Post not found");
  });

  it("awards reputation only on new like (not duplicate)", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { addReputation } = await import("../app/src/lib/reputation");
    const { likePost } = await import("../app/src/modules/posts/posts.service");

    (prisma.post.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "p1", authorId: "author-1", deletedAt: null,
    });
    // Existing like
    (prisma.postLike.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ userId: "u1" });
    (prisma.postLike.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    await likePost("u1", "p1");

    // Should NOT award reputation (duplicate like)
    expect(addReputation).not.toHaveBeenCalled();
  });

  it("awards reputation on new like", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { addReputation } = await import("../app/src/lib/reputation");
    const { likePost } = await import("../app/src/modules/posts/posts.service");

    (prisma.post.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "p1", authorId: "author-1", deletedAt: null,
    });
    // No existing like
    (prisma.postLike.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    (prisma.postLike.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    await likePost("u1", "p1");

    expect(addReputation).toHaveBeenCalledWith("author-1", "post_liked");
  });
});

describe("posts.service — deletePost", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent post", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { deletePost } = await import("../app/src/modules/posts/posts.service");

    (prisma.post.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(deletePost("p1", "u1", "USER")).rejects.toThrow("Post not found");
  });

  it("throws FORBIDDEN if user is not the author and not MOD/ADMIN", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { deletePost } = await import("../app/src/modules/posts/posts.service");

    (prisma.post.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "p1", authorId: "other-user", deletedAt: null,
    });

    await expect(deletePost("p1", "u1", "USER")).rejects.toThrow("Not allowed to delete this post");
  });

  it("allows MOD to delete any post", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { deletePost } = await import("../app/src/modules/posts/posts.service");

    (prisma.post.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "p1", authorId: "other-user", deletedAt: null,
    });
    (prisma.post.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    await expect(deletePost("p1", "mod-user", "MOD")).resolves.not.toThrow();
  });
});
