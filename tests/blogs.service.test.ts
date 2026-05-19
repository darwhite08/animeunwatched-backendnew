/**
 * Blogs service unit tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    blog: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("../app/src/lib/reputation", () => ({
  addReputation: vi.fn().mockResolvedValue(undefined),
}));

describe("blogs.service — list", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns only PUBLISHED blogs", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { list } = await import("../app/src/modules/blogs/blogs.service");

    const mockBlogs = [
      { id: "b1", title: "Test", status: "PUBLISHED", body: "content", slug: "test", authorId: "u1",
        author: { id: "u1", username: "user1", displayName: "User", avatarUrl: null },
        publishedAt: new Date(), createdAt: new Date() }
    ];
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockBlogs, 1]);

    const result = await list(1, 20);
    expect(result.data).toHaveLength(1);
    expect(result.meta.total).toBe(1);
  });
});

describe("blogs.service — getBySlug", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent slug", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getBySlug } = await import("../app/src/modules/blogs/blogs.service");

    (prisma.blog.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(getBySlug("non-existent")).rejects.toThrow("Blog not found");
  });

  it("throws NOT_FOUND for DRAFT blog viewed by non-author", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getBySlug } = await import("../app/src/modules/blogs/blogs.service");

    (prisma.blog.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "b1", status: "DRAFT", authorId: "author-id", title: "Draft", body: "...",
      author: { id: "author-id", username: "author", displayName: "Author", avatarUrl: null },
    });

    await expect(getBySlug("draft-blog", "other-user")).rejects.toThrow("Blog not found");
  });

  it("allows author to view their own draft", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getBySlug } = await import("../app/src/modules/blogs/blogs.service");

    const mockBlog = {
      id: "b1", status: "DRAFT", authorId: "author-id", title: "Draft", body: "...", slug: "draft",
      author: { id: "author-id", username: "author", displayName: "Author", avatarUrl: null },
    };
    (prisma.blog.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockBlog);

    const result = await getBySlug("draft", "author-id");
    expect(result.blog.status).toBe("DRAFT");
  });
});

describe("blogs.service — create", () => {
  beforeEach(() => vi.clearAllMocks());

  it("awards reputation for PUBLISHED blog", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { addReputation } = await import("../app/src/lib/reputation");
    const { create } = await import("../app/src/modules/blogs/blogs.service");

    const mockBlog = {
      id: "b1", status: "PUBLISHED", authorId: "u1", title: "My Blog",
      body: "Content here", slug: "my-blog",
      author: { id: "u1", username: "user1", displayName: "User", avatarUrl: null },
    };
    (prisma.blog.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockBlog);

    await create("u1", { title: "My Blog", body: "Content here", status: "PUBLISHED" });

    expect(addReputation).toHaveBeenCalledWith("u1", "blog_published");
  });

  it("does not award reputation for DRAFT blog", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { addReputation } = await import("../app/src/lib/reputation");
    const { create } = await import("../app/src/modules/blogs/blogs.service");

    const mockBlog = {
      id: "b1", status: "DRAFT", authorId: "u1", title: "Draft",
      body: "Draft content", slug: "draft",
      author: { id: "u1", username: "user1", displayName: "User", avatarUrl: null },
    };
    (prisma.blog.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockBlog);

    await create("u1", { title: "Draft", body: "Draft content", status: "DRAFT" });

    expect(addReputation).not.toHaveBeenCalled();
  });
});
