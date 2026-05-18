import { upsertFromCatalog } from "../modules/anime/anime.service"
import { env } from "../config/env"

type JikanAnime = Record<string, unknown>

function mapJikanAnime(a: JikanAnime) {
  const aired = (a.aired as Record<string, unknown>)?.from as string | null
  return {
    malId: a.mal_id as number,
    title: a.title as string,
    titleEnglish: (a.title_english as string) || null,
    titleJapanese: (a.title_japanese as string) || null,
    synopsis: (a.synopsis as string) || null,
    type: (a.type as string) || null,
    episodes: (a.episodes as number) || null,
    status: (a.status as string) || null,
    airedFrom: aired ? new Date(aired) : null,
    airedTo: null,
    season: (a.season as string) || null,
    year: (a.year as number) || null,
    rating: (a.rating as string) || null,
    score: (a.score as number) || null,
    imageUrl: ((a.images as Record<string, Record<string, string>>)?.jpg?.large_image_url) || ((a.images as Record<string, Record<string, string>>)?.jpg?.image_url) || null,
    trailerUrl: ((a.trailer as Record<string, string>)?.url) || null,
    source: (a.source as string) || null,
    genres: ((a.genres as Array<Record<string, string>>) ?? []).map((g) => g.name),
    studios: ((a.studios as Array<Record<string, string>>) ?? []).map((s) => s.name),
  }
}

export async function refreshTopAnime(): Promise<void> {
  console.log("[Job] refreshTopAnime starting")
  try {
    const res = await fetch(`${env.JIKAN_BASE_URL}/top/anime?limit=50`)
    if (!res.ok) {
      console.warn("[Job] refreshTopAnime: Jikan returned", res.status)
      return
    }
    const json = await res.json() as { data: JikanAnime[] }
    if (!json?.data?.length) {
      console.warn("[Job] refreshTopAnime: no data returned")
      return
    }

    let upserted = 0
    for (const item of json.data) {
      try {
        const mapped = mapJikanAnime(item)
        await upsertFromCatalog(mapped)
        upserted++
        await new Promise(r => setTimeout(r, 200)) // slight delay
      } catch (e) {
        // Skip individual failures silently
      }
    }
    console.log(`[Job] refreshTopAnime: upserted ${upserted}/${json.data.length} anime`)
  } catch (e) {
    console.error("[Job] refreshTopAnime failed:", e)
  }
}
