import { prisma } from "../config/prisma";

const DAY = 24 * 60 * 60_000;

/**
 * Nightly DM cleanup (spec §8):
 *  - hard-delete messages tombstoned (deletedForAll) more than 30 days ago
 *  - delete DECLINED conversations with no activity for 90 days
 * (Orphaned-media GC is deferred — media keys are content-addressed and cheap;
 *  tracked as a follow-up.)
 */
export async function runDmNightlyCleanup(): Promise<void> {
  const now = Date.now();
  await prisma.directMessage.deleteMany({
    where: { deletedAt: { lt: new Date(now - 30 * DAY) }, body: null, ciphertext: null },
  });
  await prisma.conversation.deleteMany({
    where: { status: "DECLINED", lastMessageAt: { lt: new Date(now - 90 * DAY) } },
  });
}

/**
 * Hourly safety net (spec §8): recompute unread counters for conversations
 * touched in the last hour, correcting any drift from the denormalized values.
 */
export async function runDmUnreadReconcile(): Promise<void> {
  const since = new Date(Date.now() - 60 * 60_000);
  const convs = await prisma.conversation.findMany({
    where: { lastMessageAt: { gte: since } },
    select: { id: true, participant1: true, participant2: true, p1UnreadCount: true, p2UnreadCount: true },
    take: 1000,
  });
  for (const c of convs) {
    const [p1Actual, p2Actual] = await Promise.all([
      prisma.directMessage.count({ where: { conversationId: c.id, senderId: { not: c.participant1 }, readAt: null } }),
      prisma.directMessage.count({ where: { conversationId: c.id, senderId: { not: c.participant2 }, readAt: null } }),
    ]);
    if (p1Actual !== c.p1UnreadCount || p2Actual !== c.p2UnreadCount) {
      await prisma.conversation.update({
        where: { id: c.id },
        data: { p1UnreadCount: p1Actual, p2UnreadCount: p2Actual },
      }).catch(() => {});
    }
  }
}
