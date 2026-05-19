/**
 * Analytics service unit tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    user: { count: vi.fn(), findMany: vi.fn() },
    post: { count: vi.fn(), findMany: vi.fn() },
    anime: { count: vi.fn(), findMany: vi.fn() },
    club: { count: vi.fn() },
    review: { count: vi.fn(), findMany: vi.fn() },
    blog: { count: vi.fn() },
    listEntry: { count: vi.fn() },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

describe("getPlatformStats", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns stats from all collections", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getPlatformStats } = await import("../app/src/modules/analytics/analytics.service");

    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      1000, 5000, 500, 50, 2000, 100, 15000
    ]);

    const result = await getPlatformStats();

    expect(result.users).toBe(1000);
    expect(result.posts).toBe(5000);
    expect(result.anime).toBe(500);
    expect(result.clubs).toBe(50);
    expect(result.reviews).toBe(2000);
    expect(result.blogs).toBe(100);
    expect(result.listEntries).toBe(15000);
    expect(result.timestamp).toBeInstanceOf(Date);
  });
});

describe("getTopAnime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns top anime sorted by score", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getTopAnime } = await import("../app/src/modules/analytics/analytics.service");

    const mockAnime = [
      { malId: 5114, title: "Fullmetal Alchemist: Brotherhood", score: 9.1, imageUrl: "img.jpg", type: "TV", year: 2009 },
      { malId: 9253, title: "Steins;Gate", score: 9.0, imageUrl: "img.jpg", type: "TV", year: 2011 },
    ];
    (prisma.anime.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockAnime);

    const result = await getTopAnime(2);
    expect(result).toHaveLength(2);
    expect(result[0].score).toBe(9.1);
  });

  it("uses default limit of 10", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getTopAnime } = await import("../app/src/modules/analytics/analytics.service");

    (prisma.anime.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    await getTopAnime();

    expect(prisma.anime.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 })
    );
  });
});

describe("getReputationLeaderboard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns users sorted by reputation", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getReputationLeaderboard } = await import("../app/src/modules/analytics/analytics.service");

    const mockUsers = [
      { id: "u1", username: "top", displayName: "Top", reputation: 5000, avatarUrl: null },
      { id: "u2", username: "mid", displayName: "Mid", reputation: 2500, avatarUrl: null },
    ];
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockUsers);

    const result = await getReputationLeaderboard(2);
    expect(result).toHaveLength(2);
    expect(result[0].reputation).toBe(5000);
  });
});

describe("getRecentActivity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns recent posts and reviews", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getRecentActivity } = await import("../app/src/modules/analytics/analytics.service");

    const mockPosts = [{ id: "p1", content: "Post", author: { username: "user1" } }];
    const mockReviews = [{ id: "r1", score: 8, author: { username: "user2" }, anime: { title: "One Piece" } }];
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([mockPosts, mockReviews]);

    const result = await getRecentActivity(10);
    expect(result.posts).toHaveLength(1);
    expect(result.reviews).toHaveLength(1);
  });
});
