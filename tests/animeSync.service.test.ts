/**
 * Anime sync service tests — mapper correctness, upsert idempotency, slug
 * stability and Kaiveron-enrichment preservation, driven by a real saved
 * Jikan /anime/5114/full payload (tests/fixtures/jikan-anime-5114-full.json).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fixture from "./fixtures/jikan-anime-5114-full.json";

const jikanAnime = (fixture as { data: Record<string, unknown> }).data;

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    anime: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    genre: { upsert: vi.fn(), findUnique: vi.fn() },
    studio: { upsert: vi.fn(), findUnique: vi.fn() },
    animeGenre: { deleteMany: vi.fn(), createMany: vi.fn() },
    animeStudio: { deleteMany: vi.fn(), createMany: vi.fn() },
    animeRelation: { deleteMany: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
    episode: { upsert: vi.fn() },
    syncJobLog: { create: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  },
}));

vi.mock("../app/src/lib/catalog/jikanClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/src/lib/catalog/jikanClient")>();
  return { ...actual, getAnimeEpisodesPage: vi.fn() };
});

import { prisma } from "../app/src/config/prisma";
import {
  computeSyncPriority,
  mapAnimeScalars,
  mapGenres,
  mapRelations,
  mapStudios,
} from "../app/src/lib/catalog/jikan.mapper";
import { upsertAnimeFromJikan, upsertStubFromSearchResult } from "../app/src/modules/anime/animeSync.service";
import type { JikanAnime } from "../app/src/lib/catalog/jikanClient";

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function primeHappyPath(opts?: { existing?: { id: string; slug: string | null } | null }) {
  // First findUnique: existing-row lookup; second: slug-collision check.
  mockFn(prisma.anime.findUnique)
    .mockResolvedValueOnce(opts?.existing ?? null)
    .mockResolvedValue(null);
  mockFn(prisma.genre.upsert).mockImplementation(({ create }: { create: { name: string } }) =>
    Promise.resolve({ id: `genre-${create.name}` }),
  );
  mockFn(prisma.studio.upsert).mockImplementation(({ create }: { create: { name: string } }) =>
    Promise.resolve({ id: `studio-${create.name}` }),
  );
  mockFn(prisma.anime.upsert).mockImplementation(({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) =>
    Promise.resolve({
      id: opts?.existing?.id ?? "anime-1",
      episodes: 64,
      slug: (opts?.existing?.slug ?? create.slug ?? update.slug ?? null) as string | null,
      ...(opts?.existing ? update : create),
    }),
  );
}

beforeEach(() => vi.clearAllMocks());

// ─── Mapper ──────────────────────────────────────────────────────────────────

describe("jikan.mapper with real /anime/5114/full payload", () => {
  it("maps scalar fields", () => {
    const s = mapAnimeScalars(jikanAnime as unknown as JikanAnime);
    expect(s.malId).toBe(5114);
    expect(s.title).toBe("Fullmetal Alchemist: Brotherhood");
    expect(s.titleEnglish).toBe("Fullmetal Alchemist: Brotherhood");
    expect(s.titleSynonyms).toContain("FMAB");
    expect(s.episodes).toBe(64);
    expect(s.status).toBe("Finished Airing");
    expect(s.airing).toBe(false);
    expect(s.airedFrom).toBeInstanceOf(Date);
    expect(s.imageUrl).toMatch(/^https?:\/\//);
    expect(s.score).toBeGreaterThan(8);
    // Enrichment fields must not exist on the sync-writable scalar set
    expect(s).not.toHaveProperty("kaiveronTags");
    expect(s).not.toHaveProperty("waieScore");
    expect(s).not.toHaveProperty("isFeatured");
    expect(s).not.toHaveProperty("localImagePath");
    expect(s).not.toHaveProperty("slug");
  });

  it("buckets genres/themes/demographics with their type", () => {
    const genres = mapGenres(jikanAnime as unknown as JikanAnime);
    expect(genres.length).toBeGreaterThanOrEqual(4);
    expect(genres.some((g) => g.type === "genre")).toBe(true);
    expect(genres.some((g) => g.type === "demographic")).toBe(true);
    expect(genres.every((g) => typeof g.malId === "number" && g.name.length > 0)).toBe(true);
  });

  it("maps studios + producers + licensors with roles", () => {
    const studios = mapStudios(jikanAnime as unknown as JikanAnime);
    expect(studios.some((s) => s.role === "studio" && s.name === "Bones")).toBe(true);
    expect(studios.some((s) => s.role === "producer")).toBe(true);
    expect(studios.some((s) => s.role === "licensor")).toBe(true);
  });

  it("keeps only anime→anime relations", () => {
    const rels = mapRelations(jikanAnime as unknown as JikanAnime);
    expect(rels.length).toBeGreaterThan(0);
    expect(rels.every((r) => typeof r.targetMalId === "number" && r.relationType.length > 0)).toBe(true);
  });

  it("computes sync priority", () => {
    expect(computeSyncPriority({ airing: true, status: "Currently Airing", airedFrom: null, airedTo: null })).toBe("HOT");
    expect(
      computeSyncPriority({
        airing: false,
        status: "Not yet aired",
        airedFrom: new Date(Date.now() + 10 * 24 * 60 * 60_000),
        airedTo: null,
      }),
    ).toBe("HOT");
    // FMA:B finished in 2010 → COLD
    expect(
      computeSyncPriority({
        airing: false,
        status: "Finished Airing",
        airedFrom: new Date("2009-04-05"),
        airedTo: new Date("2010-07-04"),
      }),
    ).toBe("COLD");
    expect(
      computeSyncPriority({ airing: false, status: "Finished Airing", airedFrom: new Date(), airedTo: new Date() }),
    ).toBe("NORMAL");
  });
});

// ─── upsertAnimeFromJikan ────────────────────────────────────────────────────

describe("upsertAnimeFromJikan", () => {
  it("creates the row with a generated slug and sync bookkeeping", async () => {
    primeHappyPath();
    await upsertAnimeFromJikan(jikanAnime as unknown as JikanAnime);

    const upsertArgs = mockFn(prisma.anime.upsert).mock.calls[0][0];
    expect(upsertArgs.where).toEqual({ malId: 5114 });
    expect(upsertArgs.create.slug).toBe("fullmetal-alchemist-brotherhood");
    expect(upsertArgs.create.isStub).toBe(false);
    expect(upsertArgs.create.syncFailCount).toBe(0);
    expect(upsertArgs.create.lastSyncedAt).toBeInstanceOf(Date);
    expect(upsertArgs.create.syncPriority).toBe("COLD"); // finished 2010

    // Genres, studios and relations are reconciled in one transaction
    expect(prisma.genre.upsert).toHaveBeenCalled();
    expect(prisma.studio.upsert).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalled();
    const studioRows = mockFn(prisma.animeStudio.createMany).mock.calls[0][0].data;
    expect(studioRows.some((r: { role: string }) => r.role === "producer")).toBe(true);
    const relationRows = mockFn(prisma.animeRelation.createMany).mock.calls[0][0].data;
    expect(relationRows.length).toBeGreaterThan(0);
  });

  it("is idempotent: a second upsert never rewrites slug or enrichment fields", async () => {
    primeHappyPath({ existing: { id: "anime-1", slug: "fullmetal-alchemist-brotherhood" } });

    // Simulate a changed title upstream — slug must stay put.
    const changed = { ...jikanAnime, title: "FMA Brotherhood RENAMED", title_english: "Totally New Title" };
    await upsertAnimeFromJikan(changed as unknown as JikanAnime);

    const upsertArgs = mockFn(prisma.anime.upsert).mock.calls[0][0];
    expect(upsertArgs.update).not.toHaveProperty("slug");
    expect(upsertArgs.update).not.toHaveProperty("kaiveronTags");
    expect(upsertArgs.update).not.toHaveProperty("waieScore");
    expect(upsertArgs.update).not.toHaveProperty("isFeatured");
    expect(upsertArgs.update).not.toHaveProperty("localImagePath");
    expect(upsertArgs.update.title).toBe("FMA Brotherhood RENAMED");
  });

  it("appends -malId on slug collision with a different anime", async () => {
    mockFn(prisma.anime.findUnique)
      .mockResolvedValueOnce(null) // existing-row lookup: new anime
      .mockResolvedValueOnce({ malId: 999 }); // slug taken by ANOTHER anime
    mockFn(prisma.genre.upsert).mockResolvedValue({ id: "g" });
    mockFn(prisma.studio.upsert).mockResolvedValue({ id: "s" });
    mockFn(prisma.anime.upsert).mockResolvedValue({ id: "anime-2", episodes: 64, slug: "x" });

    await upsertAnimeFromJikan(jikanAnime as unknown as JikanAnime);
    const upsertArgs = mockFn(prisma.anime.upsert).mock.calls[0][0];
    expect(upsertArgs.create.slug).toBe("fullmetal-alchemist-brotherhood-5114");
  });
});

// ─── upsertStubFromSearchResult ──────────────────────────────────────────────

describe("upsertStubFromSearchResult", () => {
  it("creates a stub row", async () => {
    primeHappyPath();
    await upsertStubFromSearchResult(jikanAnime as unknown as JikanAnime);
    const upsertArgs = mockFn(prisma.anime.upsert).mock.calls[0][0];
    expect(upsertArgs.create.isStub).toBe(true);
    expect(upsertArgs.create.slug).toBe("fullmetal-alchemist-brotherhood");
    // A stub upsert must never stamp lastSyncedAt or flip isStub on update
    expect(upsertArgs.update).not.toHaveProperty("lastSyncedAt");
    expect(upsertArgs.update).not.toHaveProperty("isStub");
  });

  it("does not touch an existing fully-synced row", async () => {
    mockFn(prisma.anime.findUnique).mockResolvedValueOnce({
      id: "anime-1",
      slug: "fullmetal-alchemist-brotherhood",
      isStub: false,
      lastSyncedAt: new Date(),
    });
    await upsertStubFromSearchResult(jikanAnime as unknown as JikanAnime);
    expect(prisma.anime.upsert).not.toHaveBeenCalled();
  });
});
