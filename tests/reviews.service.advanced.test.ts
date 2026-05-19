/**
 * Advanced reviews service tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    review: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    reviewLike: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("../app/src/lib/reputation", () => ({
  addReputation: vi.fn().mockResolvedValue(undefined),
}));

const reviewInclude = {
  author: { id: "u1", username: "user1", displayName: "User", avatarUrl: null },
  _count: { likes: 0 },
};

describe("reviews.service — getAnimeReviews", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches reviews sorted by recent (default)", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getAnimeReviews } = await import("../app/src/modules/reviews/reviews.service");

    const mockReviews = [
      { id: "r1", animeId: "a1", score: 9, body: "Great!", hasSpoilers: false, ...reviewInclude }
    ];
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockReviews, 1]);

    const result = await getAnimeReviews("a1", "recent", 1, 20);
    expect(result.data).toHaveLength(1);
    expect(result.meta.total).toBe(1);
  });

  it("fetches reviews sorted by helpful", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getAnimeReviews } = await import("../app/src/modules/reviews/reviews.service");

    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([[], 0]);

    await getAnimeReviews("a1", "helpful", 1, 20);

    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

describe("reviews.service — delete", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent review", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { deleteReview: remove } = await import("../app/src/modules/reviews/reviews.service");

    (prisma.review.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(remove("r1", "u1", "USER")).rejects.toThrow("Review not found");
  });

  it("throws FORBIDDEN if not the author", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { deleteReview: remove } = await import("../app/src/modules/reviews/reviews.service");

    (prisma.review.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "r1", authorId: "other-user",
    });

    await expect(remove("r1", "u1", "USER")).rejects.toThrow("Not allowed");
  });

  it("deletes review successfully", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { deleteReview: remove } = await import("../app/src/modules/reviews/reviews.service");

    (prisma.review.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "r1", authorId: "u1" });
    (prisma.review.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    await expect(remove("r1", "u1", "USER")).resolves.not.toThrow();
    expect(prisma.review.delete).toHaveBeenCalledWith({ where: { id: "r1" } });
  });
});

describe("reviews.service — unlike", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes the like from the database", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { unlike } = await import("../app/src/modules/reviews/reviews.service");

    (prisma.reviewLike.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 1 });

    await unlike("u1", "r1");

    expect(prisma.reviewLike.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1", reviewId: "r1" },
    });
  });
});

describe("reviews.service — listReviews", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns paginated global reviews", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { listReviews } = await import("../app/src/modules/reviews/reviews.service");

    const mockReviews = [{ id: "r1", score: 9, body: "Excellent!", ...reviewInclude }];
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockReviews, 1]);

    const result = await listReviews("recent", 1, 20);
    expect(result.data).toHaveLength(1);
  });
});
