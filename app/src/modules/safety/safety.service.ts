import { createHmac } from "node:crypto";
import { prisma } from "../../config/prisma";
import { notFound, badReq } from "../../lib/errors";
import { verifyServerFrank } from "../../lib/franking";

// ─── Block / unblock ────────────────────────────────────────────────────────
// One-directional block, enforced server-side on every DM path (the chat
// service re-checks via isBlockedEitherWay). Blocking does NOT notify the
// blocked user; existing conversations remain but all sends fail both ways.

export async function blockUser(blockerId: string, blockedId: string) {
  if (blockerId === blockedId) throw badReq("You cannot block yourself");
  const target = await prisma.user.findUnique({ where: { id: blockedId }, select: { id: true } });
  if (!target) throw notFound("User not found");
  await prisma.userBlock.upsert({
    where:  { blockerId_blockedId: { blockerId, blockedId } },
    create: { blockerId, blockedId },
    update: {},
  });
  return { ok: true };
}

export async function unblockUser(blockerId: string, blockedId: string) {
  await prisma.userBlock.deleteMany({ where: { blockerId, blockedId } });
  return { ok: true };
}

export async function listBlocked(blockerId: string) {
  const rows = await prisma.userBlock.findMany({
    where:   { blockerId },
    orderBy: { createdAt: "desc" },
    select:  {
      createdAt: true,
      blocked: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
    },
  });
  return rows.map((r) => ({ ...r.blocked, blockedAt: r.createdAt }));
}

// ─── Report ─────────────────────────────────────────────────────────────────
// Snapshots the last 50 messages into an immutable JSON `details` blob so
// moderators can review even if messages are later deleted (security §9).

export type ReportReason = "spam" | "harassment" | "nsfw" | "other";

export async function reportConversation(reporterId: string, dto: {
  conversationId: string;
  messageId?: string;
  reason: ReportReason;
  details?: string;
  evidence?: { messageId: string; plaintext: string; frankingKey: string }[];
}) {
  const conv = await prisma.conversation.findUnique({
    where:  { id: dto.conversationId },
    select: { id: true, participant1: true, participant2: true },
  });
  // IDOR → 404 if not a participant.
  if (!conv || (conv.participant1 !== reporterId && conv.participant2 !== reporterId)) {
    throw notFound("Conversation not found");
  }
  const reportedUserId = conv.participant1 === reporterId ? conv.participant2 : conv.participant1;

  // Immutable snapshot of the last 50 messages (body is null for E2EE rows).
  const recent = await prisma.directMessage.findMany({
    where:   { conversationId: conv.id },
    orderBy: { createdAt: "desc" },
    take:    50,
    select:  { id: true, senderId: true, type: true, body: true, mediaUrl: true, createdAt: true, deletedAt: true, frankingTag: true, serverFrank: true, isE2EE: true },
  });

  // Verify any submitted E2EE evidence (spec §5): HMAC(frankingKey, plaintext)
  // must equal the stored frankingTag AND the serverFrank must recompute — only
  // then is the decrypted plaintext recorded as cryptographically verified.
  const verified: Record<string, { plaintext: string; status: "verified" | "unverified" }> = {};
  for (const ev of dto.evidence ?? []) {
    const msg = recent.find((m) => m.id === ev.messageId);
    let ok = false;
    if (msg?.frankingTag && msg.serverFrank) {
      try {
        const tag = createHmac("sha256", Buffer.from(ev.frankingKey, "base64")).update(ev.plaintext).digest("base64");
        const tagOk = tag === msg.frankingTag;
        const frankOk = verifyServerFrank({
          serverFrank: msg.serverFrank, frankingTag: msg.frankingTag,
          messageId: msg.id, senderId: msg.senderId, ts: msg.createdAt.getTime(),
        });
        ok = tagOk && frankOk;
      } catch { ok = false; }
    }
    verified[ev.messageId] = { plaintext: ev.plaintext, status: ok ? "verified" : "unverified" };
  }

  const snapshot = JSON.stringify({
    reporterNote: dto.details ?? null,
    snapshotAt: new Date().toISOString(),
    messages: recent.reverse().map((m) => verified[m.id] ? { ...m, decrypted: verified[m.id].plaintext, verification: verified[m.id].status } : m),
  });

  const report = await prisma.messageReport.create({
    data: {
      reporterId,
      reportedUserId,
      conversationId: conv.id,
      messageId: dto.messageId ?? null,
      reason: dto.reason,
      details: snapshot,
    },
    select: { id: true, status: true, createdAt: true },
  });
  return report;
}

// Re-exported for callers that only need the block predicate without importing chat.
export async function isBlockedEitherWay(a: string, b: string): Promise<boolean> {
  const n = await prisma.userBlock.count({
    where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] },
  });
  return n > 0;
}
