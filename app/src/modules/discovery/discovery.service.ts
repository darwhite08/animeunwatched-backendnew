import { prisma } from "../../config/prisma";
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

export async function aiDiscovery(dto: AiPromptDto) {
  const wanted = extractGenres(dto.prompt);
  const results = await scoreAnimeByGenres(wanted, dto.limit);
  return {
    prompt: dto.prompt,
    extractedGenres: Array.from(wanted.keys()),
    data: results,
    meta: { count: results.length },
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
