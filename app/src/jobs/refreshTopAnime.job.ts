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
    imageUrl: ((a.images as Record<string, Record<string, string>>)?.jpg?.large_image_url)
      || ((a.images as Record<string, Record<string, string>>)?.jpg?.image_url) || null,
    trailerUrl: ((a.trailer as Record<string, string>)?.url) || null,
    source: (a.source as string) || null,
    genres: ((a.genres as Array<Record<string, string>>) ?? []).map((g) => g.name),
    studios: ((a.studios as Array<Record<string, string>>) ?? []).map((s) => s.name),
  }
}

async function fetchJikanPage(page: number): Promise<JikanAnime[]> {
  const res = await fetch(`${env.JIKAN_BASE_URL}/top/anime?limit=25&page=${page}`)
  if (!res.ok) throw new Error(`Jikan page ${page} returned ${res.status}`)
  const json = await res.json() as { data: JikanAnime[]; pagination: { has_next_page: boolean } }
  return json.data ?? []
}

export async function refreshTopAnime(): Promise<void> {
  console.log("[Job] refreshTopAnime starting — fetching all top anime from Jikan")
  let totalUpserted = 0
  let page = 1
  const MAX_PAGES = 20 // up to 500 anime (25 per page)

  try {
    while (page <= MAX_PAGES) {
      let items: JikanAnime[]
      try {
        items = await fetchJikanPage(page)
      } catch (e) {
        console.warn(`[Job] refreshTopAnime: page ${page} failed, stopping`)
        break
      }

      if (!items.length) break

      for (const item of items) {
        try {
          await upsertFromCatalog(mapJikanAnime(item))
          totalUpserted++
          // Jikan rate limit: 3 req/sec — 350ms gap keeps us safe
          await new Promise(r => setTimeout(r, 350))
        } catch {
          // Skip individual failures silently
        }
      }

      console.log(`[Job] refreshTopAnime: page ${page} done (${totalUpserted} total so far)`)

      // Jikan paginates 25 per page; if we got < 25 there are no more pages
      if (items.length < 25) break
      page++

      // Pause between pages to respect rate limits
      await new Promise(r => setTimeout(r, 1000))
    }

    console.log(`[Job] refreshTopAnime: complete — ${totalUpserted} anime upserted`)
  } catch (e) {
    console.error("[Job] refreshTopAnime failed:", e)
  }
}
