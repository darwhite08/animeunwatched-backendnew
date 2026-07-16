import { describe, expect, it } from "vitest";
import {
  computeMangaSyncPriority,
  mapMangaGenres,
  mapMangaScalars,
} from "../app/src/lib/catalog/manga.mapper";
import type { JikanManga } from "../app/src/lib/catalog/jikanClient";

const BASE: JikanManga = {
  mal_id: 2,
  title: "Berserk",
  title_english: "Berserk",
  title_japanese: "ベルセルク",
  title_synonyms: ["Berserk: The Prototype"],
  type: "Manga",
  chapters: null,
  volumes: null,
  status: "Publishing",
  publishing: true,
  published: { from: "1989-08-25T00:00:00+00:00", to: null },
  score: 9.47,
  scored_by: 330000,
  rank: 1,
  popularity: 2,
  members: 700000,
  favorites: 130000,
  synopsis: "Guts, a former mercenary...",
  background: null,
  images: {
    jpg: { image_url: "https://cdn.myanimelist.net/x.jpg", small_image_url: "https://cdn.myanimelist.net/xs.jpg", large_image_url: "https://cdn.myanimelist.net/xl.jpg" },
    webp: { image_url: "https://cdn.myanimelist.net/x.webp", large_image_url: "https://cdn.myanimelist.net/xl.webp", small_image_url: null },
  },
  authors: [{ mal_id: 1868, type: "people", name: "Miura, Kentarou" }],
  serializations: [{ mal_id: 1, type: "manga", name: "Young Animal" }],
  genres: [
    { mal_id: 1, type: "manga", name: "Action" },
    { mal_id: 28, type: "manga", name: "Boys Love" },
  ],
  explicit_genres: [],
  themes: [{ mal_id: 38, type: "manga", name: "Military" }],
  demographics: [{ mal_id: 42, type: "manga", name: "Seinen" }],
};

describe("mapMangaScalars", () => {
  it("maps manga-specific fields", () => {
    const s = mapMangaScalars(BASE);
    expect(s.malId).toBe(2);
    expect(s.status).toBe("Publishing");
    expect(s.publishing).toBe(true);
    expect(s.publishedFrom?.getUTCFullYear()).toBe(1989);
    expect(s.publishedTo).toBeNull();
    expect(s.demographic).toBe("Seinen");
    expect(s.authors).toEqual(["Miura, Kentarou"]);
    expect(s.serializations).toEqual(["Young Animal"]);
    expect(s.imageUrl).toBe("https://cdn.myanimelist.net/xl.jpg");
    expect(s.imageWebpUrl).toBe("https://cdn.myanimelist.net/xl.webp");
  });

  it("builds the normalized multi-title searchText haystack", () => {
    const s = mapMangaScalars(BASE);
    expect(s.searchText).toContain("berserk");
    expect(s.searchText).toContain("berserk the prototype");
  });

  it("falls back to the list-payload `scored` field when `score` is absent", () => {
    const s = mapMangaScalars({ ...BASE, score: null, scored: 8.1 });
    expect(s.score).toBe(8.1);
  });
});

describe("mapMangaGenres", () => {
  it("keeps all four buckets including demographics and BL", () => {
    const genres = mapMangaGenres(BASE);
    const names = genres.map((g) => g.name);
    expect(names).toContain("Action");
    expect(names).toContain("Boys Love"); // requested gap — must never be filtered
    expect(names).toContain("Military");
    expect(names).toContain("Seinen");
    expect(genres.find((g) => g.name === "Seinen")?.type).toBe("demographic");
  });
});

describe("computeMangaSyncPriority", () => {
  it("publishing → HOT", () => {
    expect(
      computeMangaSyncPriority({ publishing: true, status: "Publishing", publishedFrom: null, publishedTo: null }),
    ).toBe("HOT");
  });

  it("finished 2+ years ago → COLD", () => {
    expect(
      computeMangaSyncPriority({
        publishing: false,
        status: "Finished",
        publishedFrom: new Date("1990-01-01"),
        publishedTo: new Date("2000-01-01"),
      }),
    ).toBe("COLD");
  });

  it("recently finished → NORMAL", () => {
    expect(
      computeMangaSyncPriority({
        publishing: false,
        status: "Finished",
        publishedFrom: new Date("2020-01-01"),
        publishedTo: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      }),
    ).toBe("NORMAL");
  });

  it("on hiatus → NORMAL (not COLD — may resume)", () => {
    expect(
      computeMangaSyncPriority({
        publishing: false,
        status: "On Hiatus",
        publishedFrom: new Date("1990-01-01"),
        publishedTo: null,
      }),
    ).toBe("NORMAL");
  });
});
