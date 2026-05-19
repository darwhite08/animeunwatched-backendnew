/**
 * Advanced posts service tests — getPost, getComments, createComment.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
    },
    postComment: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    follow: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
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

const postInclude = {
  author: { id: "u1", username: "user1", displayName: "User", avatarUrl: null },
  anime: null,
  _count: { likes: 0, comments: 0 },
};

describe("posts.service — getPost", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for deleted post", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getPost } = await import("../app/src/modules/posts/posts.service");

    (prisma.post.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "p1", deletedAt: new Date(), // deleted
      ...postInclude,
    });

    await expect(getPost("p1")).rejects.toThrow("Post not found");
  });

  it("returns post and liked=false for unauthenticated", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getPost } = await import("../app/src/modules/posts/posts.service");

    const mockPost = { id: "p1", deletedAt: null, content: "Hello world", ...postInclude };
    (prisma.post.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPost);

    const result = await getPost("p1");
    expect(result.post.id).toBe("p1");
    expect(result.liked).toBeUndefined(); // no userId
  });

  it("returns liked status for authenticated user", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getPost } = await import("../app/src/modules/posts/posts.service");

    const mockPost = { id: "p1", deletedAt: null, content: "Hello", ...postInclude };
    (prisma.post.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPost);
    (prisma.postLike.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ userId: "u1" }); // has liked

    const result = await getPost("p1", "u1");
    expect(result.liked).toBe(true);
  });
});

describe("posts.service — getComments", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns paginated comments", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getComments } = await import("../app/src/modules/posts/posts.service");

    // getComments first checks if the post exists
    (prisma.post.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "p1", deletedAt: null });

    const mockComments = [
      { id: "c1", content: "Nice post!", postId: "p1", authorId: "u1",
        author: { id: "u1", username: "user1", displayName: "User", avatarUrl: null } }
    ];
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockComments, 1]);

    const result = await getComments("p1", 1, 20);
    expect(result.data).toHaveLength(1);
    expect(result.meta.total).toBe(1);
  });
});

describe("posts.service — createComment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent post", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { createComment } = await import("../app/src/modules/posts/posts.service");

    (prisma.post.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(createComment("p1", "u1", { content: "Nice post!" })).rejects.toThrow("Post not found");
  });

  it("throws NOT_FOUND for deleted post", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { createComment } = await import("../app/src/modules/posts/posts.service");

    (prisma.post.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "p1", deletedAt: new Date(),
    });

    await expect(createComment("p1", "u1", { content: "Comment!" })).rejects.toThrow("Post not found");
  });

  it("creates comment for existing post", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { createComment } = await import("../app/src/modules/posts/posts.service");

    (prisma.post.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "p1", deletedAt: null, authorId: "other-user" });
    const mockComment = { id: "c1", content: "Great!", postId: "p1", authorId: "u1",
      author: { id: "u1", username: "user1", displayName: "User", avatarUrl: null } };
    (prisma.postComment.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockComment);

    const result = await createComment("p1", "u1", { content: "Great!" });
    expect(result.comment.content).toBe("Great!");
  });
});

describe("posts.service — getDiscover", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns cursor-paginated discover feed", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getDiscover } = await import("../app/src/modules/posts/posts.service");

    const mockPosts = [
      { id: "p1", content: "Post 1", deletedAt: null, createdAt: new Date(), ...postInclude },
      { id: "p2", content: "Post 2", deletedAt: null, createdAt: new Date(), ...postInclude },
    ];
    (prisma.post.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPosts);

    const result = await getDiscover(undefined, 2);
    // With 2 items and limit 2, no next page
    expect(result.data).toHaveLength(2);
    expect(result.meta.nextCursor).toBeNull();
  });
});
