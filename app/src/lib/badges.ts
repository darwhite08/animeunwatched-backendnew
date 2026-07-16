import { prisma } from "../config/prisma";
import { createNotification, NotificationType } from "./notify";

/**
 * Badge system — built strictly to the engagement research
 * (RESEARCH-engagement-and-hooks.md):
 *
 *   - Badges ONLY on rare / first-time / completion actions. The Stack Overflow
 *     causal study showed first-time badges raise the rewarded action ~4x;
 *     common-action badges measured NO effect and dilute the wall. So there are
 *     deliberately NO badges for likes, comments, posts, or other daily actions.
 *   - Earned badges arrive as a surprise (no progress bar advertising them
 *     beforehand) — unpredicted rewards carry the dopamine RPE signal.
 *   - Streak milestones (7/30) are forgiving-streak milestones, not punitive
 *     goals: the streak itself already absorbs missed days via freezes.
 *
 * Catalog lives here in code; the DB stores only (userId, code, earnedAt).
 */

export const BADGES = {
  // ── First-action badges (proven causal lift) ──
  FIRST_LIST_ADD: { name: "First Scroll",     tier: "first",      desc: "Added your first anime to the archive" },
  FIRST_SHOT:     { name: "First Frame",      tier: "first",      desc: "Posted your first Shot" },
  FIRST_BLOG:     { name: "Ink Initiate",     tier: "first",      desc: "Published your first blog" },
  FIRST_REVIEW:   { name: "First Verdict",    tier: "first",      desc: "Wrote your first review" },
  FIRST_CLUB:     { name: "Found the Dojo",   tier: "first",      desc: "Joined your first community" },
  FIRST_MANGA:    { name: "First Page",       tier: "first",      desc: "Added your first manga to the readlist" },

  // ── Completion / collection badges (anime completionism drive) ──
  ARC_CLEARED:    { name: "Arc Cleared",      tier: "completion", desc: "Completed your first series" },
  ARC_CLEARED_10: { name: "Ten Arcs Deep",    tier: "completion", desc: "Completed 10 series" },
  ARC_CLEARED_50: { name: "Archive Master",   tier: "rare",       desc: "Completed 50 series" },

  // ── Reading completion badges (manga completionism drive) ──
  VOLUME_CLOSED:    { name: "Volume Closed",    tier: "completion", desc: "Completed your first manga" },
  VOLUME_CLOSED_10: { name: "Ten Volumes Shut", tier: "completion", desc: "Completed 10 manga" },
  VOLUME_CLOSED_50: { name: "Library Keeper",   tier: "rare",       desc: "Completed 50 manga" },

  // ── Streak milestones (forgiving-streak instrumentation) ──
  STREAK_7:       { name: "One Week Strong",  tier: "milestone",  desc: "Kept a 7-day streak" },
  STREAK_30:      { name: "Thirty Days",      tier: "rare",       desc: "Kept a 30-day streak" },

  // ── Founding / identity (scarce, retroactive-friendly, highly loved) ──
  // "I was here at the start" — granted to the first DAY_ONE_CAP sign-ups.
  DAY_ONE:        { name: "Day One",          tier: "founding",   desc: "Here from the beginning — one of the first 1,000 members" },
} as const;

/** Sign-up ordinal cutoff for the Day One badge. Closed forever once reached. */
export const DAY_ONE_CAP = 1000;

export type BadgeCode = keyof typeof BADGES;

/**
 * Award a badge once. Idempotent — re-awarding is a silent no-op.
 * On a genuinely new award, notify the user (surprise delivery).
 * Fire-and-forget safe: never throws.
 */
export async function awardBadge(userId: string, code: BadgeCode): Promise<boolean> {
  try {
    await prisma.userBadge.create({ data: { userId, code } });
  } catch {
    return false; // unique violation → already earned (or transient failure) — stay quiet
  }
  const meta = BADGES[code];
  void createNotification({
    recipientId: userId,
    type: NotificationType.ACHIEVEMENT,
    payload: {
      message: `Badge earned: ${meta.name} — ${meta.desc}`,
      badgeCode: code,
      badgeName: meta.name,
      badgeTier: meta.tier,
      link: "/profile",
    },
  }).catch(() => {});
  return true;
}

/** Completion-count → badge mapping, called when a series transitions to COMPLETED. */
export async function checkCompletionBadges(userId: string): Promise<void> {
  try {
    const completed = await prisma.listEntry.count({ where: { userId, status: "COMPLETED" } });
    if (completed >= 1)  await awardBadge(userId, "ARC_CLEARED");
    if (completed >= 10) await awardBadge(userId, "ARC_CLEARED_10");
    if (completed >= 50) await awardBadge(userId, "ARC_CLEARED_50");
  } catch { /* best-effort */ }
}

/** Manga completion-count → badge mapping, called when an entry transitions to COMPLETED. */
export async function checkMangaCompletionBadges(userId: string): Promise<void> {
  try {
    const completed = await prisma.mangaEntry.count({ where: { userId, status: "COMPLETED" } });
    if (completed >= 1)  await awardBadge(userId, "VOLUME_CLOSED");
    if (completed >= 10) await awardBadge(userId, "VOLUME_CLOSED_10");
    if (completed >= 50) await awardBadge(userId, "VOLUME_CLOSED_50");
  } catch { /* best-effort */ }
}

/** Streak-milestone → badge mapping, called with crossedMilestones from the streak lib. */
export async function checkStreakBadges(userId: string, milestonesCrossed: number[]): Promise<void> {
  try {
    if (milestonesCrossed.includes(7))  await awardBadge(userId, "STREAK_7");
    if (milestonesCrossed.includes(30)) await awardBadge(userId, "STREAK_30");
  } catch { /* best-effort */ }
}

/**
 * Grant the "Day One" founding badge if the user is within the first
 * DAY_ONE_CAP sign-ups. Called at registration (the new user is already counted)
 * and by the retroactive backfill. Idempotent + best-effort.
 */
export async function maybeAwardDayOne(userId: string): Promise<void> {
  try {
    const total = await prisma.user.count();
    if (total <= DAY_ONE_CAP) await awardBadge(userId, "DAY_ONE");
  } catch { /* best-effort */ }
}
