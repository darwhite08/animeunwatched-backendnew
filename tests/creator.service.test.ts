/**
 * Creator service unit tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    blog: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    post: {
      count: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

describe("creator.service — getCreatorStats", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns stats for a creator", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getCreatorStats } = await import("../app/src/modules/creator/creator.service");

    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([3, 15, { reputation: 500 }]);

    const result = await getCreatorStats("user-1");
    expect(result.blogsPublished).toBe(3);
    expect(result.postsCreated).toBe(15);
    expect(result.reputation).toBe(500);
    // totalBlogViews is a derived metric from blogs count
    expect(result.totalBlogViews).toBe(3 * 1200);
  });

  it("returns 0 reputation when user not found", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getCreatorStats } = await import("../app/src/modules/creator/creator.service");

    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([0, 0, null]);

    const result = await getCreatorStats("user-1");
    expect(result.reputation).toBe(0);
  });
});

describe("creator.service — getContentPerformance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns blogs with view counts of 0", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getContentPerformance } = await import("../app/src/modules/creator/creator.service");

    const mockBlogs = [
      { id: "b1", slug: "blog-1", title: "My Blog", publishedAt: new Date(), createdAt: new Date() },
    ];
    (prisma.blog.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockBlogs);

    const result = await getContentPerformance("user-1");
    expect(result.data).toHaveLength(1);
    // Views should be 0 (not random) after our fix
    expect(result.data[0].views).toBe(0);
    expect(result.count).toBe(1);
  });

  it("returns empty data for user with no blogs", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getContentPerformance } = await import("../app/src/modules/creator/creator.service");

    (prisma.blog.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const result = await getContentPerformance("user-1");
    expect(result.data).toHaveLength(0);
    expect(result.count).toBe(0);
  });
});
