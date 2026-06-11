import { prisma } from "../config/prisma";
import { BOARD_IDS, computeGlobalStandings } from "../modules/users/users.service";

/**
 * Daily leaderboard snapshot — records each board's all-time global standings
 * once per UTC day so the leaderboard can show real rank-movement deltas
 * (climbed / dropped / NEW) instead of fabricated ones.
 *
 * Idempotent: a board that already has rows for today is skipped, so restarts
 * and the on-boot run are safe. 14-day retention keeps the table tiny.
 */
export async function snapshotLeaderboards(): Promise<{ snapped: number; purged: number }> {
  const date = new Date().toISOString().slice(0, 10);
  let snapped = 0;

  for (const board of BOARD_IDS) {
    const exists = await prisma.leaderboardSnapshot.findFirst({
      where: { date, board },
      select: { userId: true },
    });
    if (exists) continue;

    const standings = await computeGlobalStandings(board);
    if (!standings.length) continue;

    await prisma.leaderboardSnapshot.createMany({
      data: standings.map((r, i) => ({ date, board, userId: r.uid, rank: i + 1, value: r.value })),
      skipDuplicates: true,
    });
    snapped += standings.length;
  }

  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const { count: purged } = await prisma.leaderboardSnapshot.deleteMany({
    where: { date: { lt: cutoff } },
  });

  return { snapped, purged };
}
