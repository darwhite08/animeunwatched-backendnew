/**
 * Reviews service unit tests.
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

describe("reviews.service — create", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws CONFLICT if user already reviewed this anime", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { create } = await import("../app/src/modules/reviews/reviews.service");

    (prisma.review.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "existing" });

    await expect(create("u1", { animeId: "a1", score: 8, body: "Great anime definitely worth watching", hasSpoilers: false }))
      .rejects.toThrow("You have already reviewed this anime");
  });

  it("creates a review and awards reputation", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { addReputation } = await import("../app/src/lib/reputation");
    const { create } = await import("../app/src/modules/reviews/reviews.service");

    (prisma.review.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const mockReview = { id: "r1", animeId: "a1", authorId: "u1", score: 8, body: "Great anime", hasSpoilers: false,
      author: { id: "u1", username: "user1", displayName: "User", avatarUrl: null }, _count: { likes: 0 } };
    (prisma.review.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockReview);

    const result = await create("u1", { animeId: "a1", score: 8, body: "Great anime definitely worth watching", hasSpoilers: false });

    expect(result.review.score).toBe(8);
    expect(addReputation).toHaveBeenCalledWith("u1", "review_posted");
  });
});

describe("reviews.service — like", () => {
  beforeEach(() => vi.clearAllMocks());

  it("awards reputation only on first like (not repeat likes)", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { addReputation } = await import("../app/src/lib/reputation");
    const { like } = await import("../app/src/modules/reviews/reviews.service");

    (prisma.review.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "r1", authorId: "author-1" });
    // Simulate existing like
    (prisma.reviewLike.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ userId: "u1" });
    (prisma.reviewLike.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    await like("u1", "r1");

    // Should NOT award reputation since like already existed
    expect(addReputation).not.toHaveBeenCalled();
  });

  it("awards reputation on new like", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { addReputation } = await import("../app/src/lib/reputation");
    const { like } = await import("../app/src/modules/reviews/reviews.service");

    (prisma.review.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "r1", authorId: "author-1" });
    // No existing like
    (prisma.reviewLike.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    (prisma.reviewLike.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    await like("u1", "r1");

    expect(addReputation).toHaveBeenCalledWith("author-1", "review_liked");
  });

  it("throws NOT_FOUND for non-existent review", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { like } = await import("../app/src/modules/reviews/reviews.service");

    (prisma.review.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(like("u1", "nonexistent")).rejects.toThrow("Review not found");
  });
});

describe("reviews.service — update", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws FORBIDDEN if user is not the author", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { update } = await import("../app/src/modules/reviews/reviews.service");

    (prisma.review.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "r1", authorId: "other-user",
    });

    await expect(update("r1", "u1", { score: 9 }))
      .rejects.toThrow("Not allowed to edit this review");
  });

  it("allows author to update their own review", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { update } = await import("../app/src/modules/reviews/reviews.service");

    (prisma.review.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "r1", authorId: "u1" });
    const updated = { id: "r1", score: 9, body: "Updated review", authorId: "u1",
      author: { id: "u1", username: "user1", displayName: "User", avatarUrl: null }, _count: { likes: 0 } };
    (prisma.review.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updated);

    const result = await update("r1", "u1", { score: 9 });
    expect(result.review.score).toBe(9);
  });
});
