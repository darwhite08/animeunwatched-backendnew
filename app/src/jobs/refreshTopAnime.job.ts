import { catalog } from "../lib/catalog"
import { prisma } from "../config/prisma"

export async function refreshTopAnime(): Promise<void> {
  console.log("[Job] refreshTopAnime starting")
  try {
    const topAnime = await catalog.getTopAnime({ limit: 50 })
    for (const anime of topAnime) {
      await prisma.anime.upsert({
        where: { malId: anime.malId },
        update: { title: anime.title, score: anime.score, imageUrl: anime.imageUrl },
        create: {
          malId: anime.malId, title: anime.title, score: anime.score,
          imageUrl: anime.imageUrl, type: anime.type, year: anime.year,
        },
      })
    }
    console.log(`[Job] refreshTopAnime: upserted ${topAnime.length} anime`)
  } catch (e) {
    console.error("[Job] refreshTopAnime failed:", e)
  }
}
