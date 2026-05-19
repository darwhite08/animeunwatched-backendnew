/**
 * Anime service unit tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAnime = {
  id: "anime-1",
  malId: 21,
  title: "One Piece",
  titleEnglish: "One Piece",
  titleJapanese: "ワンピース",
  synopsis: "A pirate adventure",
  type: "TV",
  episodes: null,
  status: "Currently Airing",
  airedFrom: null,
  airedTo: null,
  season: "fall",
  year: 1999,
  rating: "PG-13",
  score: 8.9,
  imageUrl: "https://example.com/image.jpg",
  trailerUrl: null,
  source: "Manga",
  updatedAt: new Date(),
  genres: [{ genre: { id: "g1", name: "Action" } }, { genre: { id: "g2", name: "Adventure" } }],
  studios: [{ studio: { id: "s1", name: "Toei Animation" } }],
};

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    genre: { upsert: vi.fn() },
    studio: { upsert: vi.fn() },
    anime: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    animeGenre: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    animeStudio: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    listEntry: { findUnique: vi.fn() },
    $transaction: vi.fn((ops) => {
      if (Array.isArray(ops)) return Promise.all(ops);
      return ops(prismaTransactionClient);
    }),
  },
}));

// Minimal transaction client for non-array tx
const prismaTransactionClient = {
  anime: { findUnique: vi.fn() },
  listEntry: { findUnique: vi.fn() },
};

vi.mock("../app/src/lib/catalog", () => ({
  catalog: {
    getAnimeByMalId: vi.fn(),
    searchAnime: vi.fn(),
  },
}));

vi.mock("../app/src/lib/cache", () => ({
  cache: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    del: vi.fn(),
  },
}));

describe("upsertFromCatalog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upserts genres and studios correctly", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { upsertFromCatalog } = await import("../app/src/modules/anime/anime.service");

    (prisma.genre.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "g1", name: "Action" });
    (prisma.studio.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "s1", name: "Toei" });
    (prisma.anime.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockAnime });
    (prisma.anime.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...mockAnime });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const result = await upsertFromCatalog({
      malId: 21,
      title: "One Piece",
      titleEnglish: "One Piece",
      titleJapanese: "ワンピース",
      synopsis: "A pirate adventure",
      type: "TV",
      episodes: null,
      status: "Currently Airing",
      airedFrom: null,
      airedTo: null,
      season: "fall",
      year: 1999,
      rating: "PG-13",
      score: 8.9,
      imageUrl: "https://example.com/image.jpg",
      trailerUrl: null,
      source: "Manga",
      genres: ["Action"],
      studios: ["Toei"],
    });

    expect(prisma.genre.upsert).toHaveBeenCalled();
    expect(prisma.studio.upsert).toHaveBeenCalled();
    expect(result.malId).toBe(21);
    expect(result.title).toBe("One Piece");
    expect(result.genres).toEqual(["Action", "Adventure"]);
    expect(result.studios).toEqual(["Toei Animation"]);
  });
});

describe("browse", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns cached results on cache hit", async () => {
    const { cache } = await import("../app/src/lib/cache");
    const { browse } = await import("../app/src/modules/anime/anime.service");

    const cachedResult = { data: [{ malId: 21, title: "One Piece" }], meta: { total: 1, page: 1, limit: 20, pages: 1 } };
    (cache.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(cachedResult);

    const result = await browse({ page: 1, limit: 20 });
    expect(result).toEqual(cachedResult);
  });
});
