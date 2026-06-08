import { prisma } from "../config/prisma";
import {
  MAX_FREEZES,
  crossedMilestones,
  decideTransition,
  freezesEarned,
  streakDateKey,
} from "./streakMath";

/**
 * Update a user's streak when they perform a qualifying activity.
 *
 * Humane, anti-frustration model (docs/streak-algorithm.md), replacing the old
 * UTC-midnight / hard-reset logic that churned users:
 *   - day boundary is the user's LOCAL calendar date + a grace window
 *   - a missed day is absorbed by an auto-consumed freeze token if available
 *   - otherwise the streak SOFT-breaks (today = 1, never 0) and the prior
 *     streak is stashed for a 48h one-tap repair
 *   - crossing a 7-day boundary grants a freeze (capped); milestones are flagged
 *
 * Idempotent within a day (multiple activities just bump the day's count).
 * Returns a small summary so callers/controllers can surface milestones/breaks.
 */
export interface StreakUpdate {
  streakDays: number;
  changed: boolean;
  broke: boolean;
  repairable: boolean;
  milestonesCrossed: number[];
  freezesGranted: number;
}

const NOOP: StreakUpdate = {
  streakDays: 0,
  changed: false,
  broke: false,
  repairable: false,
  milestonesCrossed: [],
  freezesGranted: 0,
};

export async function updateStreak(userId: string, now = new Date()): Promise<StreakUpdate> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      streakDays: true,
      bestStreak: true,
      lastStreakDate: true,
      timezone: true,
      streakFreezes: true,
    },
  });
  if (!u) return NOOP;

  const today = streakDateKey(now, u.timezone);
  const transition = decideTransition({
    lastStreakDate: u.lastStreakDate,
    today,
    streakDays: u.streakDays,
    freezes: u.streakFreezes,
  });

  // Already credited today → just bump the day's activity count.
  if (transition.kind === "same-day") {
    await prisma.streakDay.update({
      where: { userId_date: { userId, date: today } },
      data: { activityCount: { increment: 1 } },
    }).catch(() => {});
    return { ...NOOP, streakDays: u.streakDays };
  }

  // ── Compute the new streak + side effects per transition ──
  let newStreak: number;
  let broke = false;
  let repairable = false;
  let source = "activity";
  let consumeFreezes = 0;
  const extra: Record<string, unknown> = {};

  switch (transition.kind) {
    case "first":
      newStreak = 1;
      break;
    case "extend":
      newStreak = u.streakDays + 1;
      break;
    case "freeze":
      newStreak = u.streakDays + 1; // streak survives the gap
      consumeFreezes = transition.missed;
      break;
    case "break":
      newStreak = 1; // today still counts — never start from 0
      broke = true;
      repairable = true;
      extra.prevStreakDays = u.streakDays;
      extra.streakBrokenAt = now;
      break;
  }

  const milestonesCrossed = crossedMilestones(u.streakDays, newStreak);
  const earned = freezesEarned(u.streakDays, newStreak);
  const nextFreezes = Math.min(MAX_FREEZES, u.streakFreezes - consumeFreezes + earned);
  const freezesGranted = Math.max(0, nextFreezes - (u.streakFreezes - consumeFreezes));

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        streakDays: newStreak,
        bestStreak: Math.max(newStreak, u.bestStreak),
        lastStreakDate: today,
        lastActiveAt: now,
        streakFreezes: nextFreezes,
        ...(earned > 0 ? { freezeGrantedAt: now } : {}),
        ...extra,
      },
    }),
    prisma.streakDay.upsert({
      where: { userId_date: { userId, date: today } },
      create: { userId, date: today, source },
      update: { activityCount: { increment: 1 } },
    }),
  ]);

  return { streakDays: newStreak, changed: true, broke, repairable, milestonesCrossed, freezesGranted };
}

/**
 * Restore a recently-broken streak (within 48h). One free repair per ~month;
 * otherwise spends a freeze token. Converts the worst churn moment (losing a
 * long streak) into a re-engagement moment.
 */
export async function repairStreak(userId: string, now = new Date()): Promise<{ ok: boolean; reason?: string; streakDays?: number }> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { streakDays: true, prevStreakDays: true, streakBrokenAt: true, streakRepairAt: true, streakFreezes: true, bestStreak: true },
  });
  if (!u) return { ok: false, reason: "not_found" };
  if (!u.streakBrokenAt || !u.prevStreakDays) return { ok: false, reason: "nothing_to_repair" };
  if (now.getTime() - u.streakBrokenAt.getTime() > 48 * 3_600_000) return { ok: false, reason: "window_expired" };

  const freeRepairAvailable = !u.streakRepairAt || now.getTime() - u.streakRepairAt.getTime() > 30 * 24 * 3_600_000;
  const useFreeze = !freeRepairAvailable && u.streakFreezes > 0;
  if (!freeRepairAvailable && !useFreeze) return { ok: false, reason: "no_repair_available" };

  // Restore: prior streak + the days that have elapsed since (today already counted as 1).
  const restored = u.prevStreakDays + Math.max(0, u.streakDays);
  await prisma.user.update({
    where: { id: userId },
    data: {
      streakDays: restored,
      bestStreak: Math.max(restored, u.bestStreak),
      prevStreakDays: 0,
      streakBrokenAt: null,
      ...(freeRepairAvailable ? { streakRepairAt: now } : { streakFreezes: { decrement: 1 } }),
    },
  });
  return { ok: true, streakDays: restored };
}
