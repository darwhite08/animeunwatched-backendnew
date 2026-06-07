import { prisma } from "../config/prisma";

/**
 * Central privacy/safety gate for every real-time activity signal between two
 * users (presence, typing, read receipts). Returns false when either user
 * blocks the other, or when the target's visibility setting excludes the
 * viewer. All presence/typing/read emits MUST pass through this (security §3).
 *
 * @param viewerId   the user who would RECEIVE the signal
 * @param targetId   the user the signal is ABOUT
 * @param setting    which of the target's prefs governs this signal
 */
export async function canSeeActivity(
  viewerId: string,
  targetId: string,
  setting: "showOnlineStatus" | "readReceiptsOn" = "showOnlineStatus",
): Promise<boolean> {
  if (viewerId === targetId) return true;

  const blocked = await prisma.userBlock.count({
    where: { OR: [{ blockerId: viewerId, blockedId: targetId }, { blockerId: targetId, blockedId: viewerId }] },
  });
  if (blocked > 0) return false;

  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: { showOnlineStatus: true, readReceiptsOn: true },
  });
  if (!target) return false;

  if (setting === "readReceiptsOn") return target.readReceiptsOn;

  switch (target.showOnlineStatus) {
    case "nobody":    return false;
    case "everyone":  return true;
    case "followers": {
      // "followers" = accounts that follow the target may see their status.
      const n = await prisma.follow.count({
        where: { followerId: viewerId, followingId: targetId, status: "ACCEPTED" },
      });
      return n > 0;
    }
    default: return true;
  }
}
