/**
 * Read-through fallback tests for the canonical anime read path (spec §5):
 * unknown malId → ONE Jikan fetch → persisted → second request served from
 * the DB without touching Jikan. Stubs are served immediately and refreshed
 * in the background.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    anime: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    listEntry: { findUnique: vi.fn() },
    episode: { findMany: vi.fn(), count: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  },
}));

vi.mock("../app/src/lib/cache", () => ({
  cache: { get: vi.fn().mockReturnValue(null), set: vi.fn(), del: vi.fn(), delPattern: vi.fn() },
}));

vi.mock("../app/src/lib/catalog/jikanClient", () => ({
  getAnimeFull: vi.fn(),
  getRaw: vi.fn(),
  browseAnime: vi.fn(),
  searchAnimePage: vi.fn(),
  JikanError: class JikanError extends Error {},
}));

vi.mock("../app/src/modules/anime/animeSync.service", () => ({
  upsertAnimeFromJikan: vi.fn(),
  upsertStubFromSearchResult: vi.fn(),
  logSyncJob: vi.fn(),
}));

vi.mock("../app/src/modules/anime/syncQueue.service", () => ({
  enqueueAnimeFullSync: vi.fn().mockResolvedValue(null),
  enqueueEpisodeSync: vi.fn().mockResolvedValue(null),
}));

import { prisma } from "../app/src/config/prisma";
import { getAnimeFull } from "../app/src/lib/catalog/jikanClient";
import { upsertAnimeFromJikan } from "../app/src/modules/anime/animeSync.service";
import { enqueueAnimeFullSync } from "../app/src/modules/anime/syncQueue.service";
import { getById, getBySlug } from "../app/src/modules/anime/anime.service";
import { HttpError } from "../app/src/lib/errors";

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const dbRow = {
  id: "anime-1",
  malId: 5114,
  slug: "fullmetal-alchemist-brotherhood",
  title: "Fullmetal Alchemist: Brotherhood",
  titleEnglish: "Fullmetal Alchemist: Brotherhood",
  titleJapanese: "鋼の錬金術師",
  synopsis: "…",
  type: "TV",
  episodes: 64,
  status: "Finished Airing",
  airedFrom: new Date("2009-04-05"),
  airedTo: new Date("2010-07-04"),
  season: "spring",
  year: 2009,
  rating: "R",
  score: 9.1,
  imageUrl: "https://cdn.example/5114.jpg",
  trailerUrl: null,
  source: "Manga",
  updatedAt: new Date(),
  isStub: false,
  lastSyncedAt: new Date(),
  genres: [{ genre: { id: "g1", name: "Action" } }],
  studios: [{ studio: { id: "s1", name: "Bones" } }],
};

beforeEach(() => vi.clearAllMocks());

describe("getById read-through", () => {
  it("unknown malId → fetches from Jikan once, persists, serves", async () => {
    mockFn(prisma.anime.findUnique)
      .mockResolvedValueOnce(null) // miss before fallback
      .mockResolvedValueOnce(dbRow); // hit after upsert
    mockFn(getAnimeFull).mockResolvedValue({ mal_id: 5114, title: "FMA:B" });

    const result = await getById(5114);
    expect(getAnimeFull).toHaveBeenCalledTimes(1);
    expect(getAnimeFull).toHaveBeenCalledWith(5114, { timeoutMs: 8_000 });
    expect(upsertAnimeFromJikan).toHaveBeenCalledTimes(1);
    expect(result.anime.malId).toBe(5114);
    expect(result.anime.genres).toEqual(["Action"]);
  });

  it("known fresh row → served from DB, Jikan never called", async () => {
    mockFn(prisma.anime.findUnique).mockResolvedValueOnce(dbRow);
    const result = await getById(5114);
    expect(getAnimeFull).not.toHaveBeenCalled();
    expect(enqueueAnimeFullSync).not.toHaveBeenCalled();
    expect(result.anime.slug).toBe("fullmetal-alchemist-brotherhood");
  });

  it("stub row → served immediately AND background sync enqueued", async () => {
    mockFn(prisma.anime.findUnique).mockResolvedValueOnce({ ...dbRow, isStub: true, lastSyncedAt: null });
    const result = await getById(5114);
    expect(result.anime.malId).toBe(5114);
    expect(getAnimeFull).not.toHaveBeenCalled(); // request never blocks
    expect(enqueueAnimeFullSync).toHaveBeenCalledWith(5114);
  });

  it("miss + Jikan failure → clean 404", async () => {
    mockFn(prisma.anime.findUnique).mockResolvedValue(null);
    mockFn(getAnimeFull).mockRejectedValue(new Error("Jikan down"));
    await expect(getById(99999999)).rejects.toMatchObject({ status: 404 } satisfies Partial<HttpError>);
  });
});

describe("getBySlug", () => {
  it("serves by slug without any Jikan fallback on miss", async () => {
    mockFn(prisma.anime.findUnique).mockResolvedValue(null);
    await expect(getBySlug("does-not-exist")).rejects.toMatchObject({ status: 404 });
    expect(getAnimeFull).not.toHaveBeenCalled();
  });

  it("returns the row for a known slug", async () => {
    mockFn(prisma.anime.findUnique).mockResolvedValueOnce(dbRow);
    const result = await getBySlug("fullmetal-alchemist-brotherhood");
    expect(result.anime.malId).toBe(5114);
  });
});
