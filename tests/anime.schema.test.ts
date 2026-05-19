/**
 * Anime browse query schema tests.
 */
import { describe, it, expect } from "vitest";
import { browseQuerySchema } from "../app/src/modules/anime/anime.schema";

describe("browseQuerySchema", () => {
  it("accepts empty query (all defaults)", () => {
    const result = browseQuerySchema.parse({});
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
  });

  it("accepts page and limit", () => {
    const result = browseQuerySchema.parse({ page: "2", limit: "50" });
    expect(result.page).toBe(2);
    expect(result.limit).toBe(50);
  });

  it("rejects non-numeric page", () => {
    // browseQuerySchema uses coerce.number() which converts to NaN
    expect(() => browseQuerySchema.parse({ page: "abc" })).toThrow();
  });

  it("accepts valid year string", () => {
    const result = browseQuerySchema.parse({ year: "2024" });
    expect(result.year).toBe(2024);
  });

  it("accepts valid season", () => {
    const validSeasons = ["winter", "spring", "summer", "fall"];
    for (const season of validSeasons) {
      const result = browseQuerySchema.parse({ season });
      expect(result.season).toBe(season);
    }
  });

  it("rejects invalid season", () => {
    expect(() => browseQuerySchema.parse({ season: "monsoon" })).toThrow();
  });

  it("accepts valid type values", () => {
    const validTypes = ["TV", "Movie", "OVA", "ONA", "Special", "Music"];
    for (const type of validTypes) {
      const result = browseQuerySchema.parse({ type });
      expect(result.type).toBe(type);
    }
  });

  it("accepts search query q", () => {
    const result = browseQuerySchema.parse({ q: "naruto" });
    expect(result.q).toBe("naruto");
  });

  it("rejects limit above 100", () => {
    // browseQuerySchema has max: 100 for limit
    expect(() => browseQuerySchema.parse({ limit: "200" })).toThrow();
  });

  it("accepts status filter", () => {
    const result = browseQuerySchema.parse({ status: "Finished Airing" });
    expect(result.status).toBe("Finished Airing");
  });
});
