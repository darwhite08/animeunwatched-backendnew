export interface CatalogAnime {
  malId: number;
  title: string;
  titleEnglish: string | null;
  titleJapanese: string | null;
  synopsis: string | null;
  type: string | null;
  episodes: number | null;
  status: string | null;
  airedFrom: Date | null;
  airedTo: Date | null;
  season: string | null;
  year: number | null;
  rating: string | null;
  score: number | null;
  imageUrl: string | null;
  trailerUrl: string | null;
  source: string | null;
  genres: string[];
  studios: string[];
}

export interface CatalogProvider {
  getAnimeByMalId(malId: number): Promise<CatalogAnime | null>;
  searchAnime(query: string, opts?: { limit?: number }): Promise<CatalogAnime[]>;
  getSeasonal(
    year: number,
    season: "winter" | "spring" | "summer" | "fall",
  ): Promise<CatalogAnime[]>;
  getTopAnime(opts?: { type?: string; limit?: number }): Promise<CatalogAnime[]>;
}
