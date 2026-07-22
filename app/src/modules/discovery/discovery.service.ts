import { prisma } from "../../config/prisma";
import { cache } from "../../lib/cache";
import { groqJSON, groqEnabled } from "../../lib/groq";
import { getSimilar } from "../anime/anime.service";
import type { AiPromptDto, MoodDto, QuizDto } from "./discovery.schema";

const animeInclude = {
  genres:  { include: { genre:  true } },
  studios: { include: { studio: true } },
} as const;

type AnimeRow = Awaited<ReturnType<typeof prisma.anime.findFirst>> & {
  genres:  Array<{ genre:  { id: string; name: string } }>;
  studios: Array<{ studio: { id: string; name: string } }>;
};

function flatten(a: AnimeRow) {
  return {
    id: a.id, malId: a.malId, title: a.title,
    titleJapanese: a.titleJapanese, titleEnglish: a.titleEnglish,
    synopsis: a.synopsis, type: a.type, episodes: a.episodes, status: a.status,
    airedFrom: a.airedFrom, airedTo: a.airedTo, season: a.season, year: a.year,
    rating: a.rating, score: a.score, imageUrl: a.imageUrl, trailerUrl: a.trailerUrl,
    source: a.source, updatedAt: a.updatedAt,
    genres:  a.genres.map(g => g.genre.name),
    studios: a.studios.map(s => s.studio.name),
  };
}

// ─── Prompt → keyword extraction ────────────────────────────────────────────

const KEYWORD_TO_GENRE: Array<{ kw: RegExp; genre: string; weight: number }> = [
  { kw: /thriller|suspense|tension/i,             genre: "Suspense",     weight: 3 },
  { kw: /psychological|mind|cerebral/i,           genre: "Psychological", weight: 3 },
  { kw: /horror|scary|terrify/i,                  genre: "Horror",       weight: 3 },
  { kw: /romance|romantic|love/i,                 genre: "Romance",      weight: 3 },
  { kw: /comed|funny|hilarious|laugh/i,           genre: "Comedy",       weight: 3 },
  { kw: /action|fight|battle/i,                   genre: "Action",       weight: 3 },
  { kw: /adventure|journey|quest/i,               genre: "Adventure",    weight: 3 },
  { kw: /mystery|whodunit|investigat/i,           genre: "Mystery",      weight: 3 },
  { kw: /drama|emotional|gut.?punch|tear/i,       genre: "Drama",        weight: 3 },
  { kw: /sci.?fi|science.?fiction|space|future/i, genre: "Sci-Fi",       weight: 3 },
  { kw: /fantasy|magic|isekai|reincarn/i,         genre: "Fantasy",      weight: 3 },
  { kw: /slice.?of.?life|chill|cozy|relax/i,      genre: "Slice of Life", weight: 3 },
  { kw: /sport|athletic|team/i,                   genre: "Sports",       weight: 3 },
  { kw: /music|band|song|orchestra/i,             genre: "Music",        weight: 3 },
  { kw: /mecha|robot|gundam/i,                    genre: "Mecha",        weight: 3 },
  { kw: /supernatural|ghost|spirit/i,             genre: "Supernatural", weight: 3 },
  { kw: /historical|samurai|edo/i,                genre: "Historical",   weight: 2 },
  { kw: /school|student|class/i,                  genre: "School",       weight: 2 },
];

function extractGenres(prompt: string): Map<string, number> {
  const matches = new Map<string, number>();
  for (const { kw, genre, weight } of KEYWORD_TO_GENRE) {
    if (kw.test(prompt)) {
      matches.set(genre, (matches.get(genre) ?? 0) + weight);
    }
  }
  return matches;
}

// ─── Mood → genre weighting ─────────────────────────────────────────────────

const MOOD_TO_GENRES: Record<MoodDto["mood"], string[]> = {
  "uplifting":         ["Slice of Life", "Comedy", "Sports", "Music"],
  "melancholic":       ["Drama", "Slice of Life", "Romance"],
  "intense":           ["Thriller", "Suspense", "Action", "Psychological"],
  "cozy":              ["Slice of Life", "Comedy", "Iyashikei"],
  "thrilling":         ["Action", "Adventure", "Thriller"],
  "romantic":          ["Romance", "Drama"],
  "thought-provoking": ["Psychological", "Sci-Fi", "Mystery", "Philosophy"],
  "epic":              ["Adventure", "Action", "Fantasy", "Drama"],
  "lighthearted":      ["Comedy", "Slice of Life"],
  "dark":              ["Horror", "Psychological", "Drama", "Thriller"],
};

// ─── Shared anime scorer + fetcher ──────────────────────────────────────────

async function scoreAnimeByGenres(
  wantedGenres: Map<string, number>,
  limit: number,
  options: { minScore?: number; preferEra?: "classic" | "modern"; length?: QuizDto["answers"]["preferredLength"] } = {},
) {
  if (wantedGenres.size === 0) {
    // Fallback: just return top-rated anime
    const rows = await prisma.anime.findMany({
      where: { score: { not: null, gte: options.minScore ?? 7 } },
      include: animeInclude,
      orderBy: { score: "desc" },
      take: limit,
    });
    return rows.map(r => ({ anime: flatten(r as AnimeRow), match: 80 }));
  }

  // Pull a wider candidate set then re-rank by genre overlap
  const genreNames = Array.from(wantedGenres.keys());
  const where: Record<string, unknown> = {
    score: { not: null, gte: options.minScore ?? 6.5 },
    genres: { some: { genre: { name: { in: genreNames } } } },
  };
  if (options.preferEra === "classic") where.year = { lte: 2010 };
  if (options.preferEra === "modern")  where.year = { gte: 2015 };
  if (options.length === "movie")      where.type = "Movie";
  if (options.length === "short")      where.episodes = { lte: 13 };
  if (options.length === "medium")     where.episodes = { gte: 13, lte: 26 };
  if (options.length === "long")       where.episodes = { gte: 26 };

  const candidates = await prisma.anime.findMany({
    where,
    include: animeInclude,
    orderBy: { score: "desc" },
    take: Math.max(limit * 4, 60),
  });

  // Score each candidate: how many of its genres overlap with what we want
  const ranked = candidates.map(c => {
    const row = c as AnimeRow;
    let score = 0;
    let overlaps = 0;
    for (const g of row.genres) {
      const weight = wantedGenres.get(g.genre.name);
      if (weight) { score += weight; overlaps++ }
    }
    // Tie-breaker: community score nudges the order
    score += (row.score ?? 0) * 0.3;
    // Boost: more genre overlaps = stronger match
    if (overlaps > 1) score += overlaps;
    // Normalize match% (cap at 99)
    const maxPossible = Array.from(wantedGenres.values()).reduce((s, v) => s + v, 0) + 10;
    const match = Math.min(99, Math.max(60, Math.round((score / maxPossible) * 100)));
    return { anime: flatten(row), match };
  });

  ranked.sort((a, b) => b.match - a.match || (b.anime.score ?? 0) - (a.anime.score ?? 0));
  return ranked.slice(0, limit);
}

// ─── Public services ─────────────────────────────────────────────────────────

// ─── AI Discover — Groq-grounded pipeline ────────────────────────────────────
//
// Two stages, both grounded so the model can NEVER surface an anime that isn't
// in our catalog:
//   1. UNDERSTAND — Groq parses the free-text prompt into a structured intent
//      (genres from OUR real vocabulary, theme keywords, "like X" title anchors,
//      era/length/score filters, exclusions). Nuance the old regex missed
//      ("overpowered MC who hides it", "no filler", "devastating ending",
//      "like Death Note but funnier") is captured here.
//   2. RETRIEVE + RERANK — we pull real catalog candidates from three sources
//      (genre overlap, synopsis keyword match, neighbors of the anchor titles),
//      then Groq reranks ONLY those candidates by malId, adding a one-line
//      reason. It cannot invent titles — it can only order real rows.
//
// Degrades to the legacy regex matcher when GROQ_API_KEY is unset or Groq errors.

interface DiscoverIntent {
  genres: string[];        // constrained to catalog genre names
  keywords: string[];      // theme words to match against synopsis
  titleAnchors: string[];  // anime the user references ("like Steins;Gate")
  excludeGenres: string[];
  era: "classic" | "modern" | null;
  length: "movie" | "short" | "medium" | "long" | null;
  minScore: number | null;
}

/** Distinct catalog genre names — the controlled vocabulary handed to the model
 *  so it can only pick genres we actually have. Cached 1h. */
async function catalogGenreNames(): Promise<string[]> {
  const key = "discovery:genre-vocab";
  const cached = cache.get<string[]>(key);
  if (cached) return cached;
  const rows = await prisma.genre.findMany({ select: { name: true }, orderBy: { name: "asc" } });
  const names = rows.map(r => r.name);
  cache.set(key, names, 60 * 60_000);
  return names;
}

const INTENT_SYSTEM = (genres: string[]) =>
  `You turn a natural-language anime request into a strict JSON search intent. ` +
  `Capture the REAL intent including nuance, themes, tone, and any anime the user references.\n\n` +
  `Return ONLY this JSON object:\n` +
  `{"genres":string[],"keywords":string[],"titleAnchors":string[],"excludeGenres":string[],` +
  `"era":"classic"|"modern"|null,"length":"movie"|"short"|"medium"|"long"|null,"minScore":number|null}\n\n` +
  `Rules:\n` +
  `- "genres" and "excludeGenres" MUST be chosen ONLY from this exact list (copy spelling): ${genres.join(", ")}.\n` +
  `- "keywords": 0-6 concise theme/plot words to look for in synopses (e.g. "revenge","time loop","found family","hidden power"). Lowercase, no genres.\n` +
  `- "titleAnchors": 0-3 specific anime titles the user compares to ("like X"). Empty if none named.\n` +
  `- "era": "classic" if they want older/retro, "modern" if recent/new, else null.\n` +
  `- "length": map "movie"/"short series"/"one-cour"/"long-running" appropriately, else null.\n` +
  `- "minScore": a 0-10 number if they demand high quality ("only the best", "highly rated"), else null.\n` +
  `- Never invent genres outside the list. Output JSON only.`;

interface RerankOut { results: Array<{ malId: number; match: number; reason: string }> }

const RERANK_SYSTEM =
  `You are an expert anime recommender. Given a user's request and a numbered list of REAL candidate anime, ` +
  `select and rank the ones that best satisfy the request — honor nuance, themes, and tone, not just genre labels.\n\n` +
  `Return ONLY JSON: {"results":[{"malId":number,"match":number,"reason":string}]}\n` +
  `- Use ONLY malId values from the provided candidates. Never invent one.\n` +
  `- "match": 0-100 how well it fits the request.\n` +
  `- "reason": 6-14 words, SPECIFIC and concrete — reference the exact theme, tone, or compared title the user asked for. ` +
  `Never generic filler like "great anime", "epic story", or "similar vibes".\n` +
  `- Write reasons in clear English.\n` +
  `- Order best first. Include only genuinely good fits (drop weak ones).`;

type CandidateRow = ReturnType<typeof flatten>;

/** Resolve a referenced title to a REAL catalogued anime — local only (no
 *  Jikan), most-popular match wins. Returns null if we don't have it. */
async function resolveLocalTitle(anchor: string): Promise<{ malId: number } | null> {
  const q = anchor.trim();
  if (q.length < 2) return null;
  const row = await prisma.anime.findFirst({
    where: {
      OR: [
        { title:        { contains: q, mode: "insensitive" } },
        { titleEnglish: { contains: q, mode: "insensitive" } },
        { titleSynonyms: { has: q } },
      ],
    },
    orderBy: [{ membersCount: { sort: "desc", nulls: "last" } }, { score: { sort: "desc", nulls: "last" } }],
    select: { malId: true },
  });
  return row?.malId ? { malId: row.malId } : null;
}

/** Gather a deduped candidate pool of REAL catalog rows from genre overlap,
 *  synopsis keyword matches, and neighbors of the referenced titles. */
async function gatherCandidates(intent: DiscoverIntent, excludeAnimeIds: Set<string>): Promise<CandidateRow[]> {
  const minScore = intent.minScore ?? 6;
  const byMalId = new Map<number, CandidateRow>();

  const filters: Record<string, unknown> = {};
  if (intent.era === "classic") filters.year = { lte: 2010 };
  if (intent.era === "modern")  filters.year = { gte: 2015 };
  if (intent.length === "movie")  filters.type = "Movie";
  if (intent.length === "short")  filters.episodes = { lte: 13 };
  if (intent.length === "medium") filters.episodes = { gte: 13, lte: 26 };
  if (intent.length === "long")   filters.episodes = { gte: 26 };

  const collect = (rows: AnimeRow[]) => {
    for (const r of rows) {
      if (excludeAnimeIds.has(r.id)) continue;
      if (!byMalId.has(r.malId)) byMalId.set(r.malId, flatten(r));
    }
  };

  // 1) Genre overlap
  if (intent.genres.length) {
    const rows = await prisma.anime.findMany({
      where: {
        score: { not: null, gte: minScore },
        genres: { some: { genre: { name: { in: intent.genres } } } },
        ...(intent.excludeGenres.length ? { NOT: { genres: { some: { genre: { name: { in: intent.excludeGenres } } } } } } : {}),
        ...filters,
      },
      include: animeInclude,
      orderBy: { score: "desc" },
      take: 30,
    });
    collect(rows as AnimeRow[]);
  }

  // 2) Synopsis keyword matches (theme words)
  if (intent.keywords.length) {
    const rows = await prisma.anime.findMany({
      where: {
        score: { not: null, gte: Math.min(minScore, 6.5) },
        OR: intent.keywords.slice(0, 6).map(k => ({ synopsis: { contains: k, mode: "insensitive" as const } })),
        ...filters,
      },
      include: animeInclude,
      orderBy: { score: "desc" },
      take: 24,
    });
    collect(rows as AnimeRow[]);
  }

  // 3) Neighbors of referenced titles ("like X"). LOCAL-ONLY resolution — we
  // never hit Jikan here, so an anchor can only ever resolve to an anime we've
  // actually catalogued (no fake/stub output), and it's fast.
  for (const anchor of intent.titleAnchors.slice(0, 3)) {
    try {
      const top = await resolveLocalTitle(anchor);
      if (!top) continue;
      const similar = await getSimilar(top.malId, 12);
      // Fetch the neighbors through our own include so flatten() types line up.
      const malIds = (similar as Array<{ malId: number }>).map(s => s.malId).filter(Boolean);
      if (malIds.length) {
        const rows = await prisma.anime.findMany({
          where: { malId: { in: malIds }, ...filters },
          include: animeInclude,
        });
        collect(rows as AnimeRow[]);
      }
    } catch { /* anchor unresolved — skip */ }
  }

  return Array.from(byMalId.values());
}

export async function aiDiscovery(dto: AiPromptDto, userId?: string) {
  // Exclusion set: what the signed-in user already tracks (don't recommend it back).
  const excludeAnimeIds = new Set<string>();
  if (userId) {
    const entries = await prisma.listEntry.findMany({ where: { userId }, select: { animeId: true } });
    for (const e of entries) excludeAnimeIds.add(e.animeId);
  }

  // ── Legacy path when Groq is off ──
  if (!groqEnabled()) {
    const wanted = extractGenres(dto.prompt);
    const results = await scoreAnimeByGenres(wanted, dto.limit);
    return { prompt: dto.prompt, extractedGenres: Array.from(wanted.keys()), data: results, meta: { count: results.length, source: "keyword" } };
  }

  // ── Stage 1: understand ──
  const genres = await catalogGenreNames();
  const intent = await groqJSON<DiscoverIntent>(INTENT_SYSTEM(genres), dto.prompt, { temperature: 0.1, maxTokens: 400 });

  if (!intent) {
    // Groq unavailable mid-request → graceful regex fallback.
    const wanted = extractGenres(dto.prompt);
    const results = await scoreAnimeByGenres(wanted, dto.limit);
    return { prompt: dto.prompt, extractedGenres: Array.from(wanted.keys()), data: results, meta: { count: results.length, source: "keyword-fallback" } };
  }

  // Validate genres against the real vocabulary (defends against any stray label).
  const vocab = new Set(genres.map(g => g.toLowerCase()));
  intent.genres = (intent.genres ?? []).filter(g => vocab.has(g.toLowerCase()));
  intent.excludeGenres = (intent.excludeGenres ?? []).filter(g => vocab.has(g.toLowerCase()));
  intent.keywords = (intent.keywords ?? []).filter(k => typeof k === "string" && k.length > 1).slice(0, 6);
  intent.titleAnchors = (intent.titleAnchors ?? []).filter(t => typeof t === "string" && t.length > 1).slice(0, 3);

  // ── Stage 2: retrieve real candidates ──
  const candidates = await gatherCandidates(intent, excludeAnimeIds);

  // Nothing matched the parsed intent → fall back to genre scoring on the intent's genres.
  if (candidates.length === 0) {
    const wanted = new Map<string, number>();
    for (const g of intent.genres) wanted.set(g, 3);
    const results = await scoreAnimeByGenres(wanted, dto.limit);
    return { prompt: dto.prompt, extractedGenres: intent.genres, data: results, meta: { count: results.length, source: "groq-genre" } };
  }

  // ── Stage 2b: rerank the real candidates with reasons ──
  const shortlist = candidates.slice(0, 40);
  const compact = shortlist.map(c => ({
    malId: c.malId,
    title: c.titleEnglish || c.title,
    year: c.year,
    score: c.score,
    genres: c.genres,
    synopsis: (c.synopsis ?? "").slice(0, 220),
  }));
  const rerank = await groqJSON<RerankOut>(
    RERANK_SYSTEM,
    `Request: "${dto.prompt}"\n\nCandidates (JSON):\n${JSON.stringify(compact)}\n\nReturn the best ${dto.limit} as specified.`,
    { temperature: 0.2, maxTokens: 1200 },
  );

  const byMal = new Map(shortlist.map(c => [c.malId, c]));
  let data: Array<{ anime: CandidateRow; match: number; reason?: string }>;
  if (rerank?.results?.length) {
    data = rerank.results
      .filter(r => byMal.has(r.malId))
      .slice(0, dto.limit)
      .map(r => ({ anime: byMal.get(r.malId)!, match: Math.min(99, Math.max(50, Math.round(r.match))), reason: (r.reason ?? "").slice(0, 120) }));
  } else {
    // Rerank failed → return the retrieved candidates ordered by community score.
    data = shortlist
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, dto.limit)
      .map(c => ({ anime: c, match: Math.min(95, Math.round((c.score ?? 7) * 10)) }));
  }

  return {
    prompt: dto.prompt,
    extractedGenres: intent.genres,
    intent: { keywords: intent.keywords, titleAnchors: intent.titleAnchors, era: intent.era, length: intent.length },
    data,
    meta: { count: data.length, source: rerank?.results?.length ? "groq" : "groq-retrieve" },
  };
}

export async function moodDiscovery(dto: MoodDto) {
  const wanted = new Map<string, number>();
  for (const g of MOOD_TO_GENRES[dto.mood]) wanted.set(g, 3);
  if (dto.energy === "high") {
    wanted.set("Action", (wanted.get("Action") ?? 0) + 2);
  }
  if (dto.energy === "low") {
    wanted.set("Slice of Life", (wanted.get("Slice of Life") ?? 0) + 2);
  }
  if (dto.depth === "deep") {
    wanted.set("Psychological", (wanted.get("Psychological") ?? 0) + 2);
    wanted.set("Drama",          (wanted.get("Drama") ?? 0) + 2);
  }
  const results = await scoreAnimeByGenres(wanted, dto.limit);
  return {
    mood: dto.mood,
    energy: dto.energy ?? null,
    depth: dto.depth ?? null,
    data: results,
    meta: { count: results.length },
  };
}

export async function quizDiscovery(dto: QuizDto) {
  const wanted = new Map<string, number>();
  if (dto.answers.favoriteGenre) wanted.set(dto.answers.favoriteGenre, 4);
  if (dto.answers.tone === "funny")   wanted.set("Comedy", (wanted.get("Comedy") ?? 0) + 3);
  if (dto.answers.tone === "serious") wanted.set("Drama",  (wanted.get("Drama") ?? 0) + 3);
  if (dto.answers.pacing === "slow-burn") {
    wanted.set("Slice of Life",  (wanted.get("Slice of Life") ?? 0) + 2);
    wanted.set("Psychological",  (wanted.get("Psychological") ?? 0) + 1);
  }
  if (dto.answers.pacing === "fast-paced") {
    wanted.set("Action",    (wanted.get("Action") ?? 0) + 3);
    wanted.set("Adventure", (wanted.get("Adventure") ?? 0) + 2);
  }
  const results = await scoreAnimeByGenres(wanted, dto.limit, {
    preferEra: dto.answers.era === "any" ? undefined : dto.answers.era,
    length:    dto.answers.preferredLength,
  });
  return {
    answers: dto.answers,
    data: results,
    meta: { count: results.length },
  };
}
