/**
 * One-off (re-runnable) catalog transfer: LOCAL Postgres → PRODUCTION Postgres.
 *
 * Why not pg_dump? Anime.id (and Genre/Studio ids) are random cuids — the same
 * malId has a DIFFERENT id locally vs in prod, and prod's rows are referenced
 * by user ListEntries. A raw dump would conflict on malId or orphan those
 * references. This script transfers by NATURAL KEY (malId / name) so prod's
 * existing rows keep their ids (user FKs survive) and only new titles are added.
 *
 * Idempotent: safe to run repeatedly (e.g. again once the local sync finishes).
 * Touches ONLY catalog tables — never user/auth/social data.
 *
 *   PROD_DATABASE_URL=postgres://... npx tsx scripts/transfer-anime-to-prod.ts
 */
import "dotenv/config";
import { PrismaClient } from "../app/src/generated/prisma/client";

const PROD_URL = process.env.PROD_DATABASE_URL;
if (!PROD_URL) {
  console.error("[transfer] PROD_DATABASE_URL env var is required");
  process.exit(1);
}

const local = new PrismaClient({ log: ["error"] });
const prod = new PrismaClient({ datasourceUrl: PROD_URL, log: ["error"] });

const BATCH = 1000;
async function createManyBatched<T>(
  label: string,
  rows: T[],
  insert: (chunk: T[]) => Promise<{ count: number }>,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { count } = await insert(chunk);
    total += count;
    process.stdout.write(`\r[transfer] ${label}: ${Math.min(i + BATCH, rows.length)}/${rows.length} (inserted ${total})   `);
  }
  process.stdout.write("\n");
  return total;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  console.log("[transfer] connecting…");
  await Promise.all([local.$queryRaw`SELECT 1`, prod.$queryRaw`SELECT 1`]);

  // ── 1. ANIME (upsert by malId; preserve prod id for existing rows) ──────────
  const localAnime = await local.anime.findMany({ where: { lastSyncedAt: { not: null } } });
  console.log(`[transfer] local fully-synced anime: ${localAnime.length}`);

  const prodExisting = await prod.anime.findMany({ select: { id: true, malId: true } });
  const animeIdByMal = new Map<number, string>(prodExisting.map((a) => [a.malId, a.id]));
  console.log(`[transfer] prod already has ${prodExisting.length} anime — preserving their ids`);

  // Scalar columns sync may write (mirrors animeSync.service — excludes nothing
  // here since we ARE the source of truth for the catalog).
  const animeScalar = (a: (typeof localAnime)[number]) => ({
    malId: a.malId, slug: a.slug, title: a.title,
    titleEnglish: a.titleEnglish, titleJapanese: a.titleJapanese, titleSynonyms: a.titleSynonyms,
    synopsis: a.synopsis, background: a.background, type: a.type, episodes: a.episodes,
    status: a.status, airing: a.airing, airedFrom: a.airedFrom, airedTo: a.airedTo,
    duration: a.duration, season: a.season, year: a.year, rating: a.rating,
    score: a.score, scoredBy: a.scoredBy, rank: a.rank, popularity: a.popularity,
    membersCount: a.membersCount, favoritesCount: a.favoritesCount,
    imageUrl: a.imageUrl, imageSmallUrl: a.imageSmallUrl, imageWebpUrl: a.imageWebpUrl,
    trailerUrl: a.trailerUrl, trailerYoutubeId: a.trailerYoutubeId,
    broadcastDay: a.broadcastDay, broadcastTime: a.broadcastTime, broadcastTz: a.broadcastTz,
    source: a.source, lastSyncedAt: a.lastSyncedAt, syncPriority: a.syncPriority, isStub: a.isStub,
  });

  const newAnime = localAnime.filter((a) => !animeIdByMal.has(a.malId));
  const existingAnime = localAnime.filter((a) => animeIdByMal.has(a.malId));

  // New: bulk insert reusing local cuid (no conflict — prod doesn't have them).
  await createManyBatched("anime (new)", newAnime, (chunk) =>
    prod.anime.createMany({
      data: chunk.map((a) => ({ id: a.id, ...animeScalar(a) })),
      skipDuplicates: true,
    }),
  );
  for (const a of newAnime) animeIdByMal.set(a.malId, a.id);

  // Existing: update scalars (keeps prod id + any user FK references intact).
  let updated = 0;
  for (const a of existingAnime) {
    await prod.anime.update({ where: { malId: a.malId }, data: animeScalar(a) }).catch(() => {});
    if (++updated % 100 === 0) process.stdout.write(`\r[transfer] anime (update existing): ${updated}/${existingAnime.length}   `);
  }
  process.stdout.write(`\r[transfer] anime (update existing): ${existingAnime.length}/${existingAnime.length}\n`);

  // ── 2. GENRES (upsert by name) ──────────────────────────────────────────────
  const localGenres = await local.genre.findMany();
  for (const g of localGenres) {
    await prod.genre.upsert({
      where: { name: g.name },
      create: { name: g.name, malId: g.malId, type: g.type },
      update: { malId: g.malId, type: g.type },
    }).catch(() => {});
  }
  const prodGenres = await prod.genre.findMany({ select: { id: true, name: true } });
  const genreIdByName = new Map(prodGenres.map((g) => [g.name, g.id]));
  console.log(`[transfer] genres synced (${genreIdByName.size} total in prod)`);

  // ── 3. STUDIOS (upsert by name) ─────────────────────────────────────────────
  const localStudios = await local.studio.findMany();
  const prodStudioNames = new Set((await prod.studio.findMany({ select: { name: true } })).map((s) => s.name));
  await createManyBatched(
    "studios (new)",
    localStudios.filter((s) => !prodStudioNames.has(s.name)),
    (chunk) => prod.studio.createMany({ data: chunk.map((s) => ({ name: s.name, malId: s.malId })), skipDuplicates: true }),
  );
  const prodStudios = await prod.studio.findMany({ select: { id: true, name: true } });
  const studioIdByName = new Map(prodStudios.map((s) => [s.name, s.id]));

  // Local id→name maps so we can translate join rows into prod-id space.
  const localGenreName = new Map((await local.genre.findMany({ select: { id: true, name: true } })).map((g) => [g.id, g.name]));
  const localStudioName = new Map((await local.studio.findMany({ select: { id: true, name: true } })).map((s) => [s.id, s.name]));
  const localAnimeMal = new Map(localAnime.map((a) => [a.id, a.malId]));

  // ── 4. ANIME↔GENRE links (skipDuplicates; idempotent) ───────────────────────
  const localAG = await local.animeGenre.findMany();
  const agRows = localAG
    .map((r) => {
      const prodA = animeIdByMal.get(localAnimeMal.get(r.animeId)!);
      const prodG = genreIdByName.get(localGenreName.get(r.genreId)!);
      return prodA && prodG ? { animeId: prodA, genreId: prodG } : null;
    })
    .filter((r): r is { animeId: string; genreId: string } => r !== null);
  await createManyBatched("animeGenre", agRows, (chunk) => prod.animeGenre.createMany({ data: chunk, skipDuplicates: true }));

  // ── 5. ANIME↔STUDIO links ───────────────────────────────────────────────────
  const localAS = await local.animeStudio.findMany();
  const asRows = localAS
    .map((r) => {
      const prodA = animeIdByMal.get(localAnimeMal.get(r.animeId)!);
      const prodS = studioIdByName.get(localStudioName.get(r.studioId)!);
      return prodA && prodS ? { animeId: prodA, studioId: prodS, role: r.role } : null;
    })
    .filter((r): r is { animeId: string; studioId: string; role: string } => r !== null);
  await createManyBatched("animeStudio", asRows, (chunk) => prod.animeStudio.createMany({ data: chunk, skipDuplicates: true }));

  // ── 6. EPISODES (skipDuplicates on (animeId, malEpisodeId)) ──────────────────
  const localEps = await local.episode.findMany();
  const epRows = localEps
    .map((e) => {
      const prodA = animeIdByMal.get(localAnimeMal.get(e.animeId)!);
      return prodA
        ? {
            animeId: prodA, malEpisodeId: e.malEpisodeId, title: e.title,
            titleJapanese: e.titleJapanese, titleRomaji: e.titleRomaji, aired: e.aired,
            score: e.score, filler: e.filler, recap: e.recap, synopsis: e.synopsis,
          }
        : null;
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
  await createManyBatched("episodes", epRows, (chunk) => prod.episode.createMany({ data: chunk, skipDuplicates: true }));

  // ── 7. RELATIONS (resolve targetId via prod malId map) ──────────────────────
  const localRel = await local.animeRelation.findMany();
  const relRows = localRel
    .map((r) => {
      const prodSource = animeIdByMal.get(localAnimeMal.get(r.sourceId)!);
      return prodSource
        ? {
            sourceId: prodSource, targetMalId: r.targetMalId,
            targetId: animeIdByMal.get(r.targetMalId) ?? null, relationType: r.relationType,
          }
        : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  await createManyBatched("relations", relRows, (chunk) => prod.animeRelation.createMany({ data: chunk, skipDuplicates: true }));

  // ── Verify ──────────────────────────────────────────────────────────────────
  const [pa, pe, pr] = await Promise.all([prod.anime.count(), prod.episode.count(), prod.animeRelation.count()]);
  console.log(`\n[transfer] DONE in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  console.log(`[transfer] prod now has: ${pa} anime, ${pe} episodes, ${pr} relations`);
}

main()
  .catch((err) => {
    console.error("\n[transfer] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await local.$disconnect();
    await prod.$disconnect();
  });
