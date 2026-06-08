import type { CatalogAnime, CatalogProvider } from "./types";
import { getAnimeFull, getSeasonPage, getTopAnimePage, searchAnimePage, getSchedulesPage, type JikanAnime } from "./jikanClient";
import { mapJikanToCatalog } from "./jikan.mapper";

// ─── JikanProvider ────────────────────────────────────────────────────────────
// Thin CatalogProvider implementation over the shared rate-limited client
// (lib/catalog/jikanClient.ts). All throttling/retries live in the client so
// the provider, the sync worker and read-through fallbacks share one limiter.

export class JikanProvider implements CatalogProvider {
  async getAnimeByMalId(malId: number): Promise<CatalogAnime | null> {
    try {
      const data = await getAnimeFull(malId);
      return mapJikanToCatalog(data as unknown as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  async searchAnime(query: string, opts?: { limit?: number }): Promise<CatalogAnime[]> {
    try {
      const res = await searchAnimePage(query, { limit: opts?.limit ?? 10 });
      return (res.data ?? []).map((a: JikanAnime) => mapJikanToCatalog(a as unknown as Record<string, unknown>));
    } catch {
      return [];
    }
  }

  async getSeasonal(
    year: number,
    season: "winter" | "spring" | "summer" | "fall",
  ): Promise<CatalogAnime[]> {
    try {
      const res = await getSeasonPage(year, season);
      return (res.data ?? []).map((a: JikanAnime) => mapJikanToCatalog(a as unknown as Record<string, unknown>));
    } catch {
      return [];
    }
  }

  async getTopAnime(opts?: { type?: string; limit?: number }): Promise<CatalogAnime[]> {
    try {
      const res = await getTopAnimePage(1);
      const limit = opts?.limit ?? 25;
      let items = res.data ?? [];
      if (opts?.type) items = items.filter((a) => a.type?.toLowerCase() === opts.type?.toLowerCase());
      return items.slice(0, limit).map((a: JikanAnime) => mapJikanToCatalog(a as unknown as Record<string, unknown>));
    } catch {
      return [];
    }
  }

  async getSchedule(day: "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday"): Promise<CatalogAnime[]> {
    try {
      const res = await getSchedulesPage(day);
      const seen = new Set<number>();
      return (res.data ?? [])
        .map((a: JikanAnime) => mapJikanToCatalog(a as unknown as Record<string, unknown>))
        .filter((a: CatalogAnime) => a.malId && !seen.has(a.malId) && seen.add(a.malId));
    } catch {
      return [];
    }
  }
}
