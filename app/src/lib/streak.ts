import { prisma } from "../config/prisma";

/**
 * Update a user's streak when they perform any activity.
 * Rules:
 *   - If last active today: no change (already counted today)
 *   - If last active yesterday: streak + 1
 *   - If last active 2+ days ago: streak resets to 1
 *   - Always updates lastActiveAt and bestStreak
 */
export async function updateStreak(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { streakDays: true, lastActiveAt: true, bestStreak: true },
  });
  if (!user) return;

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

  if (user.lastActiveAt) {
    const lastStr = user.lastActiveAt.toISOString().slice(0, 10);
    if (lastStr === todayStr) return; // already active today

    const msInDay = 86_400_000;
    const daysSinceLast = Math.floor((now.getTime() - user.lastActiveAt.getTime()) / msInDay);

    let newStreak: number;
    if (daysSinceLast === 1) {
      newStreak = user.streakDays + 1; // continued streak
    } else {
      newStreak = 1; // reset
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        streakDays: newStreak,
        lastActiveAt: now,
        bestStreak: Math.max(newStreak, user.bestStreak),
      },
    });
  } else {
    // First activity ever
    await prisma.user.update({
      where: { id: userId },
      data: { streakDays: 1, lastActiveAt: now, bestStreak: 1 },
    });
  }
}
