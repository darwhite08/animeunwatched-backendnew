/**
 * Streak day-boundary math — pure, timezone-correct, grace-aware, unit-testable.
 * (docs/streak-algorithm.md §2). Fixes the UTC-midnight churn bug: a "streak
 * day" is the calendar date IN THE USER'S TIMEZONE, with a grace window so
 * late-night activity (before GRACE_HOURS) counts toward the previous day.
 */

export const GRACE_HOURS = 4;
export const MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365];
export const MAX_FREEZES = 5;

/**
 * The streak-day key ("YYYY-MM-DD") for an instant, in `tz`, grace-shifted so
 * 00:00–(GRACE_HOURS-1):59 local belongs to the previous calendar day.
 */
export function streakDateKey(at: Date, tz: string): string {
  const shifted = new Date(at.getTime() - GRACE_HOURS * 3_600_000);
  // en-CA gives ISO YYYY-MM-DD; timeZone does the local-calendar conversion.
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(shifted);
  } catch {
    // Invalid tz → fall back to UTC (still grace-shifted).
    return shifted.toISOString().slice(0, 10);
  }
}

/** Whole days from day-key `a` to day-key `b` (b - a). */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Milestones newly crossed when streak goes prev → curr (e.g. 6→7 → [7]). */
export function crossedMilestones(prev: number, curr: number): number[] {
  return MILESTONES.filter((m) => prev < m && curr >= m);
}

/** Number of freeze tokens earned crossing prev → curr (one per 7-day boundary). */
export function freezesEarned(prev: number, curr: number): number {
  if (curr <= prev) return 0;
  return Math.floor(curr / 7) - Math.floor(prev / 7);
}

export type StreakTransition =
  | { kind: "same-day" }
  | { kind: "first" }
  | { kind: "extend" }
  | { kind: "freeze"; missed: number }
  | { kind: "break" };

/**
 * Decide what happens to a streak given the last credited day, today, the
 * current streak, and freezes on hand. Pure — the caller persists the result.
 */
export function decideTransition(args: {
  lastStreakDate: string | null;
  today: string;
  streakDays: number;
  freezes: number;
}): StreakTransition {
  const { lastStreakDate, today, streakDays, freezes } = args;
  if (!lastStreakDate) return { kind: "first" };
  if (lastStreakDate === today) return { kind: "same-day" };

  const gap = dayDiff(lastStreakDate, today);
  if (gap <= 1) return { kind: "extend" }; // consecutive (gap 1) or clock skew (≤0)

  const missed = gap - 1; // days with no activity between last and today
  if (streakDays > 0 && freezes >= missed) return { kind: "freeze", missed };
  return { kind: "break" };
}
