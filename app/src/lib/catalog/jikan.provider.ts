import { env } from "../../config/env";
import type { CatalogAnime, CatalogProvider } from "./types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapJikanToCatalog(data: Record<string, unknown>): CatalogAnime {
  const aired = (data.aired ?? {}) as Record<string, string | null>;
  const images = (data.images ?? {}) as Record<string, Record<string, string | null>>;
  const trailer = (data.trailer ?? {}) as Record<string, string | null>;
  const genres = (data.genres as Array<{ name: string }> | null) ?? [];
  const studios = (data.studios as Array<{ name: string }> | null) ?? [];

  return {
    malId: data.mal_id as number,
    title: (data.title as string) ?? "",
    titleEnglish: (data.title_english as string | null) ?? null,
    titleJapanese: (data.title_japanese as string | null) ?? null,
    synopsis: (data.synopsis as string | null) ?? null,
    type: (data.type as string | null) ?? null,
    episodes: (data.episodes as number | null) ?? null,
    status: (data.status as string | null) ?? null,
    airedFrom: aired.from ? new Date(aired.from) : null,
    airedTo: aired.to ? new Date(aired.to) : null,
    season: (data.season as string | null) ?? null,
    year: (data.year as number | null) ?? null,
    rating: (data.rating as string | null) ?? null,
    score: (data.score as number | null) ?? null,
    imageUrl: images.jpg?.large_image_url ?? null,
    trailerUrl: trailer.url ?? null,
    source: (data.source as string | null) ?? null,
    genres: genres.map((g) => g.name),
    studios: studios.map((s) => s.name),
  };
}

// ─── JikanProvider ────────────────────────────────────────────────────────────

export class JikanProvider implements CatalogProvider {
  private lastCall = 0;

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastCall;
    if (elapsed < 350) {
      await sleep(350 - elapsed);
    }
    this.lastCall = Date.now();
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    try {
      await this.throttle();
      const res = await fetch(url);
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  async getAnimeByMalId(malId: number): Promise<CatalogAnime | null> {
    const data = await this.fetchJson<{ data: Record<string, unknown> }>(
      `${env.JIKAN_BASE_URL}/anime/${malId}/full`,
    );
    if (!data?.data) return null;
    return mapJikanToCatalog(data.data);
  }

  async searchAnime(query: string, opts?: { limit?: number }): Promise<CatalogAnime[]> {
    const limit = opts?.limit ?? 10;
    const data = await this.fetchJson<{ data: Array<Record<string, unknown>> }>(
      `${env.JIKAN_BASE_URL}/anime?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
    if (!data?.data) return [];
    return data.data.map(mapJikanToCatalog);
  }

  async getSeasonal(
    year: number,
    season: "winter" | "spring" | "summer" | "fall",
  ): Promise<CatalogAnime[]> {
    const data = await this.fetchJson<{ data: Array<Record<string, unknown>> }>(
      `${env.JIKAN_BASE_URL}/seasons/${year}/${season}`,
    );
    if (!data?.data) return [];
    return data.data.map(mapJikanToCatalog);
  }

  async getTopAnime(opts?: { type?: string; limit?: number }): Promise<CatalogAnime[]> {
    const limit = opts?.limit ?? 25;
    const typeParam = opts?.type ? `&type=${encodeURIComponent(opts.type)}` : "";
    const data = await this.fetchJson<{ data: Array<Record<string, unknown>> }>(
      `${env.JIKAN_BASE_URL}/top/anime?limit=${limit}${typeParam}`,
    );
    if (!data?.data) return [];
    return data.data.map(mapJikanToCatalog);
  }
}
