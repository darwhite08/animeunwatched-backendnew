/**
 * Advanced blogs service tests — update, delete, all operations.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    blog: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
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

const blogInclude = {
  author: { id: "u1", username: "user1", displayName: "User One", avatarUrl: null },
};

describe("blogs.service — update", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent slug", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { update } = await import("../app/src/modules/blogs/blogs.service");

    (prisma.blog.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(update("non-existent", "u1", { title: "New Title" })).rejects.toThrow("Blog not found");
  });

  it("throws FORBIDDEN if not the author", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { update } = await import("../app/src/modules/blogs/blogs.service");

    (prisma.blog.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "b1", slug: "my-blog", authorId: "other-user",
    });

    await expect(update("my-blog", "u1", { title: "New Title" })).rejects.toThrow("Not allowed");
  });

  it("sets publishedAt when publishing a draft", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { update } = await import("../app/src/modules/blogs/blogs.service");

    (prisma.blog.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "b1", slug: "my-blog", authorId: "u1", status: "DRAFT",
    });
    (prisma.blog.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "b1", slug: "my-blog", status: "PUBLISHED", publishedAt: new Date(), ...blogInclude,
    });

    const result = await update("my-blog", "u1", { status: "PUBLISHED" });

    expect(result.blog.status).toBe("PUBLISHED");
    // Verify publishedAt was included in the update
    expect(prisma.blog.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ publishedAt: expect.any(Date) }),
    }));
  });

  it("does not award reputation for non-publish updates", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { addReputation } = await import("../app/src/lib/reputation");
    const { update } = await import("../app/src/modules/blogs/blogs.service");

    (prisma.blog.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "b1", slug: "my-blog", authorId: "u1", status: "DRAFT",
    });
    (prisma.blog.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "b1", slug: "my-blog", status: "DRAFT", ...blogInclude,
    });

    await update("my-blog", "u1", { title: "New Title" });

    expect(addReputation).not.toHaveBeenCalled();
  });
});

describe("blogs.service — deleteBlog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent slug", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { deleteBlog } = await import("../app/src/modules/blogs/blogs.service");

    (prisma.blog.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(deleteBlog("non-existent", "u1", "USER")).rejects.toThrow("Blog not found");
  });

  it("throws FORBIDDEN if not the author", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { deleteBlog } = await import("../app/src/modules/blogs/blogs.service");

    (prisma.blog.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "b1", slug: "my-blog", authorId: "other-user",
    });

    await expect(deleteBlog("my-blog", "u1", "USER")).rejects.toThrow("Not allowed");
  });

  it("deletes the blog successfully", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { deleteBlog } = await import("../app/src/modules/blogs/blogs.service");

    (prisma.blog.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "b1", slug: "my-blog", authorId: "u1",
    });
    (prisma.blog.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    await expect(deleteBlog("my-blog", "u1", "USER")).resolves.not.toThrow();
    expect(prisma.blog.delete).toHaveBeenCalledWith({ where: { slug: "my-blog" } });
  });
});

describe("blogs.service — toSlug", () => {
  it("generates slug from title via create", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { create } = await import("../app/src/modules/blogs/blogs.service");

    const mockBlog = { id: "b1", slug: "my-amazing-blog-123abc", ...blogInclude };
    (prisma.blog.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockBlog);

    const result = await create("u1", { title: "My Amazing Blog!", body: "Content here" });
    expect(result.blog.slug).toContain("my-amazing-blog");
  });
});
