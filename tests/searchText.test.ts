import { describe, it, expect } from "vitest";
import { normalizeForSearch, buildSearchText } from "../app/src/lib/searchText";

describe("normalizeForSearch", () => {
  it("lowercases + strips diacritics", () => {
    expect(normalizeForSearch("Café Déjà Vu")).toBe("cafe deja vu");
    expect(normalizeForSearch("Pokémon")).toBe("pokemon");
  });

  it("collapses punctuation and whitespace to single spaces", () => {
    expect(normalizeForSearch("Re:Zero")).toBe("re zero");
    expect(normalizeForSearch("Fate/Zero")).toBe("fate zero");
    expect(normalizeForSearch("JoJo's   Bizarre  Adventure")).toBe("jojo s bizarre adventure");
    expect(normalizeForSearch("  Steins;Gate  ")).toBe("steins gate");
  });

  it("makes punctuation/spacing variants of the same title converge", () => {
    // "Re:Zero", "re zero" normalize the same; "rezero" is the no-space form.
    expect(normalizeForSearch("Re:Zero")).toBe(normalizeForSearch("re zero"));
    expect(normalizeForSearch("re-zero")).toBe(normalizeForSearch("re zero"));
  });

  it("handles null/undefined/empty", () => {
    expect(normalizeForSearch(null)).toBe("");
    expect(normalizeForSearch(undefined)).toBe("");
    expect(normalizeForSearch("   ")).toBe("");
  });
});

describe("buildSearchText", () => {
  it("concatenates all title variants, normalized + deduped", () => {
    const s = buildSearchText({
      title: "Shingeki no Kyojin",
      titleEnglish: "Attack on Titan",
      titleJapanese: "進撃の巨人",
      titleSynonyms: ["AoT", "SnK"],
    });
    expect(s).toContain("shingeki no kyojin");
    expect(s).toContain("attack on titan");
    expect(s).toContain("aot");
    expect(s).toContain("snk");
  });

  it("dedupes identical normalized variants", () => {
    const s = buildSearchText({ title: "Naruto", titleEnglish: "Naruto", titleSynonyms: ["NARUTO"] });
    expect(s).toBe("naruto");
  });

  it("tolerates missing fields", () => {
    expect(buildSearchText({ title: "One Piece" })).toBe("one piece");
    expect(buildSearchText({})).toBe("");
  });
});
