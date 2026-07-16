// Shared search normalization. Applied to BOTH the stored per-anime haystack
// ("searchText") and the incoming query, so "Re:Zero", "rezero" and "re zero"
// all reduce to the same tokens and match. Latin-folded: NFKD strips diacritics,
// punctuation/whitespace collapse to single spaces. (Kanji is intentionally
// dropped — MAL's default `title` is romaji, so romaji queries already match;
// pure-kanji input falls through to the Jikan upstream fallback.)
//
// Kept deliberately in lockstep with the SQL backfill in ensureSchema.ts
// (lower(unaccent(...)) + regexp_replace('[^a-z0-9]+',' ')) so stored + freshly
// upserted rows normalize identically.
export function normalizeForSearch(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ") // punctuation → space
    .replace(/\s+/g, " ")
    .trim();
}

/** Build the searchable haystack from every title variant. */
export function buildSearchText(parts: {
  title?: string | null;
  titleEnglish?: string | null;
  titleJapanese?: string | null;
  titleSynonyms?: string[] | null;
}): string {
  const variants = [
    parts.title,
    parts.titleEnglish,
    parts.titleJapanese,
    ...(parts.titleSynonyms ?? []),
  ];
  const normed = variants.map(normalizeForSearch).filter(Boolean);
  // Dedupe identical normalized variants so the haystack stays compact.
  return [...new Set(normed)].join(" ");
}
