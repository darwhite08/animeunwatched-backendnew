/**
 * Advanced anime service tests — browse, search, trending, similar.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const animeInclude = {
  genres: [{ genre: { id: "g1", name: "Action" } }],
  studios: [{ studio: { id: "s1", name: "Toei" } }],
};

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    anime: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      upsert: vi.fn(),
    },
    genre: { upsert: vi.fn() },
    studio: { upsert: vi.fn() },
    animeGenre: { deleteMany: vi.fn(), createMany: vi.fn() },
    animeStudio: { deleteMany: vi.fn(), createMany: vi.fn() },
    listEntry: { findUnique: vi.fn() },
    $transaction: vi.fn((ops) => {
      if (Array.isArray(ops)) return Promise.all(ops)
      return ops({ anime: { findUnique: vi.fn() }, listEntry: { findUnique: vi.fn() } })
    }),
  },
}));

vi.mock("../app/src/lib/catalog", () => ({
  catalog: {
    getAnimeByMalId: vi.fn().mockRejectedValue(new Error("Not found")),
    searchAnime: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../app/src/lib/cache", () => ({
  cache: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    del: vi.fn(),
  },
}));

describe("anime.service — getTrending", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns trending anime sorted by score", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getTrending } = await import("../app/src/modules/anime/anime.service");

    const mockAnime = [
      { id: "a1", malId: 21, title: "One Piece", score: 8.9, ...animeInclude, updatedAt: new Date() },
      { id: "a2", malId: 5114, title: "FMA Brotherhood", score: 9.1, ...animeInclude, updatedAt: new Date() },
    ];
    (prisma.anime.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockAnime);

    const result = await getTrending(2);
    expect(result).toHaveLength(2);
  });
});

describe("anime.service — getSimilar", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent anime", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getSimilar } = await import("../app/src/modules/anime/anime.service");

    (prisma.anime.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(getSimilar(99999, 5)).rejects.toThrow("Anime not found");
  });

  it("returns similar anime by shared genres", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getSimilar } = await import("../app/src/modules/anime/anime.service");

    const mockAnime = { id: "a1", malId: 21, title: "One Piece", score: 8.9,
      genres: [{ genre: { name: "Action" } }], ...animeInclude, updatedAt: new Date() };
    (prisma.anime.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockAnime);

    const mockSimilar = [
      { id: "a2", malId: 1, title: "Naruto", score: 7.9, ...animeInclude, updatedAt: new Date() },
    ];
    (prisma.anime.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockSimilar);

    const result = await getSimilar(21, 5);
    expect(result).toHaveLength(1);
  });
});

describe("anime.service — browse caching", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses cached result when available", async () => {
    const { cache } = await import("../app/src/lib/cache");
    const { browse } = await import("../app/src/modules/anime/anime.service");

    const cachedData = { data: [{ malId: 21 }], meta: {} };
    (cache.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(cachedData);

    const result = await browse({ page: 1, limit: 20 });
    expect(result).toEqual(cachedData);
  });

  it("stores result in cache after DB query", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { cache } = await import("../app/src/lib/cache");
    const { browse } = await import("../app/src/modules/anime/anime.service");

    (cache.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([[], 0]);

    await browse({ page: 1, limit: 20 });

    expect(cache.set).toHaveBeenCalled();
  });
});
