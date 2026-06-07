import jwt from "jsonwebtoken";
import { prisma } from "../../config/prisma";
import { getIo } from "../../realtime/io-instance";
import { notFound, forbidden, badReq, conflict } from "../../lib/errors";
import { env } from "../../config/env";
import { pushToUser } from "../../lib/push";
import { isOnline, isViewing } from "../../realtime/presence";
import { canSeeActivity } from "../../realtime/activityGuard";

// ─── DM v2 helpers ──────────────────────────────────────────────────────────

// Generic, non-leaking rejection for block/privacy failures (security §7).
export const dmRejection = () => forbidden("Unable to send message");

/** True if EITHER user blocks the other (block is enforced both directions). */
export async function isBlockedEitherWay(a: string, b: string): Promise<boolean> {
  const n = await prisma.userBlock.count({
    where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] },
  });
  return n > 0;
}

/** Does `follower` follow `followee` with an accepted follow? */
async function follows(follower: string, followee: string): Promise<boolean> {
  const n = await prisma.follow.count({
    where: { followerId: follower, followingId: followee, status: "ACCEPTED" },
  });
  return n > 0;
}

/** Strip HTML so message bodies render as plain text everywhere (security §4). */
function sanitizeBody(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim();
}

type ConvSides = { participant1: string; participant2: string };
const isP1 = (conv: ConvSides, userId: string) => conv.participant1 === userId;
const otherOf = (conv: ConvSides, userId: string) =>
  conv.participant1 === userId ? conv.participant2 : conv.participant1;

const PENDING_INITIATOR_MAX = 3;          // message-request cap before acceptance
const EDIT_WINDOW_MS         = 15 * 60 * 1000;
const MEDIA_URL_PREFIXES = [
  "https://media.kaiveron.com/",
  ...(env.S3_PUBLIC_URL ? [env.S3_PUBLIC_URL.replace(/\/$/, "") + "/"] : []),
  ...(env.R2_PUBLIC_URL ? [env.R2_PUBLIC_URL.replace(/\/$/, "") + "/"] : []),
];
const isOurMediaUrl = (url: string) => MEDIA_URL_PREFIXES.some((p) => url.startsWith(p));

// ─── Public key management ────────────────────────────────────────────────────

export async function upsertPublicKey(userId: string, publicKey: string) {
  return prisma.userPublicKey.upsert({
    where:  { userId },
    create: { userId, publicKey },
    update: { publicKey },
  });
}

export async function getPublicKey(userId: string) {
  const row = await prisma.userPublicKey.findUnique({ where: { userId } });
  if (!row) throw notFound("Public key not found for this user");
  return row;
}

// ─── Multi-device keys (Phase 1, additive) ─────────────────────────────────────
// Append-or-update a device's public key (never overwrites OTHER devices). This
// is what fixes the multi-device problem — the old upsertPublicKey replaced the
// single per-user key.
export async function registerDeviceKey(userId: string, deviceId: string, publicKey: string) {
  return prisma.userDeviceKey.upsert({
    where:  { userId_deviceId: { userId, deviceId } },
    create: { userId, deviceId, publicKey },
    update: { publicKey },
  });
}

// All device public keys for a user (sender encrypts a message key for each).
export async function getDeviceKeys(userId: string) {
  return prisma.userDeviceKey.findMany({
    where:   { userId },
    select:  { id: true, deviceId: true, publicKey: true },
    orderBy: { createdAt: "asc" },
  });
}

// ─── Conversation management ──────────────────────────────────────────────────

export async function getOrCreateConversation(callerId: string, recipientId: string) {
  if (callerId === recipientId) {
    throw conflict("Cannot start a conversation with yourself");
  }

  // Ensure the recipient exists
  const recipient = await prisma.user.findUnique({
    where:  { id: recipientId },
    select: { id: true, username: true, displayName: true, avatarUrl: true, dmPrivacy: true },
  });
  if (!recipient) throw notFound("User not found");

  // Block check (both directions) — generic rejection, never reveal direction.
  if (await isBlockedEitherWay(callerId, recipientId)) throw dmRejection();

  // Canonical ordering: smaller id is participant1
  const [p1, p2] = [callerId, recipientId].sort();

  const existing = await prisma.conversation.findUnique({
    where:  { participant1_participant2: { participant1: p1, participant2: p2 } },
    select: { id: true, participant1: true, participant2: true, createdAt: true, status: true },
  });

  let conversation = existing;
  if (!conversation) {
    // Privacy gate for a NEW conversation. `nobody` blocks outright; otherwise
    // it's ACTIVE when the recipient already follows the initiator, else PENDING
    // (message-request flow). `followers` and `everyone` resolve the same way
    // here; `followers` only differs in discovery surfaces elsewhere.
    if (recipient.dmPrivacy === "nobody") throw dmRejection();
    const recipientFollowsCaller = await follows(recipientId, callerId);
    const status = recipientFollowsCaller ? "ACTIVE" : "PENDING";
    conversation = await prisma.conversation.create({
      data: {
        participant1: p1,
        participant2: p2,
        status,
        initiatorId: callerId,
        lastMessageAt: new Date(),
      },
      select: { id: true, participant1: true, participant2: true, createdAt: true, status: true },
    });
  }

  // Fetch other user's public key (legacy E2E — may be null)
  const recipientKey = await prisma.userPublicKey.findUnique({ where: { userId: recipientId } });

  return {
    id:        conversation.id,
    otherUser: { id: recipient.id, username: recipient.username, displayName: recipient.displayName, avatarUrl: recipient.avatarUrl },
    status:    conversation.status,
    publicKey: recipientKey?.publicKey ?? null,
    createdAt: conversation.createdAt,
  };
}

function previewOf(m: { type: string; body: string | null; ciphertext: string | null; iv: string | null; deletedAt: Date | null } | null): string | null {
  if (!m) return null;
  if (m.deletedAt) return "🚫 This message was deleted";
  if (m.type === "IMAGE") return "📷 Photo";
  if (m.type === "VOICE") return "🎤 Voice message";
  if (m.type === "ANIME_CARD") return "📺 Anime";
  if (m.body != null) return m.body.slice(0, 120);
  // Legacy plaintext-marker rows decode from base64; true E2E stays opaque.
  if (m.iv === "PLAIN_NO_E2E" && m.ciphertext) {
    try { return Buffer.from(m.ciphertext, "base64").toString("utf8").slice(0, 120); } catch { /* noop */ }
  }
  return "🔒 Encrypted message";
}

export async function listConversations(userId: string, opts: { cursor?: string; limit?: number; filter?: "active" | "requests" } = {}) {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const filter = opts.filter ?? "active";

  const conversations = await prisma.conversation.findMany({
    where: {
      OR: [{ participant1: userId }, { participant2: userId }],
      // Active tab = ACTIVE convs; Requests tab = PENDING convs where I'm the recipient.
      ...(filter === "requests"
        ? { status: "PENDING", NOT: { initiatorId: userId } }
        : { status: "ACTIVE" }),
      ...(opts.cursor ? { lastMessageAt: { lt: new Date(opts.cursor) } } : {}),
    },
    orderBy: { lastMessageAt: "desc" },
    take: limit + 1,
    include: {
      user1: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      user2: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, senderId: true, type: true, body: true, ciphertext: true, iv: true, createdAt: true, readAt: true, deletedAt: true },
      },
    },
  });

  const hasMore = conversations.length > limit;
  const page = hasMore ? conversations.slice(0, limit) : conversations;

  const data = page.map((conv) => {
    const meIsP1 = conv.participant1 === userId;
    const otherUser = meIsP1 ? conv.user2 : conv.user1;
    const last = conv.messages[0] ?? null;
    return {
      id: conv.id,
      otherUser,
      lastMessage: last,
      lastMessagePreview: previewOf(last),
      lastMessageMine: last ? last.senderId === userId : false,
      updatedAt: conv.lastMessageAt,
      unreadCount: meIsP1 ? conv.p1UnreadCount : conv.p2UnreadCount,
      mutedUntil: meIsP1 ? conv.p1MutedUntil : conv.p2MutedUntil,
      status: conv.status,
    };
  });

  return { data, meta: { nextCursor: hasMore ? page[page.length - 1].lastMessageAt.toISOString() : null } };
}

/** Total unread across all of a user's conversations (navbar badge). */
export async function unreadCount(userId: string): Promise<number> {
  const rows = await prisma.conversation.findMany({
    where: { OR: [{ participant1: userId }, { participant2: userId }], status: "ACTIVE" },
    select: { participant1: true, p1UnreadCount: true, p2UnreadCount: true },
  });
  return rows.reduce((sum, c) => sum + (c.participant1 === userId ? c.p1UnreadCount : c.p2UnreadCount), 0);
}

/** Online + last-seen for a user, filtered by their showOnlineStatus + blocks. */
export async function getPresence(viewerId: string, targetId: string) {
  if (!(await canSeeActivity(viewerId, targetId, "showOnlineStatus"))) {
    return { userId: targetId, online: false, lastSeenAt: null, visible: false };
  }
  const u = await prisma.user.findUnique({ where: { id: targetId }, select: { dmLastSeenAt: true } });
  return { userId: targetId, online: isOnline(targetId), lastSeenAt: u?.dmLastSeenAt ?? null, visible: true };
}

/**
 * On socket connect: mark every message TO this user that wasn't yet delivered
 * as delivered now, and return the per-sender receipts so the socket layer can
 * notify each sender (chat.delivered). Idempotent.
 */
export async function deliverUndelivered(userId: string) {
  const pending = await prisma.directMessage.findMany({
    where: {
      deliveredAt: null,
      senderId: { not: userId },
      conversation: { OR: [{ participant1: userId }, { participant2: userId }] },
    },
    select: { id: true, senderId: true, conversationId: true },
    take: 500,
  });
  if (pending.length === 0) return [];
  const now = new Date();
  await prisma.directMessage.updateMany({
    where: { id: { in: pending.map((m) => m.id) } },
    data: { deliveredAt: now },
  });
  return pending.map((m) => ({ ...m, deliveredAt: now }));
}

/** Persist presence last-seen (caller throttles via presence.shouldPersistLastSeen). */
export async function persistLastSeen(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { dmLastSeenAt: new Date() } }).catch(() => {});
}

/** Mute/unmute for the calling participant. `until=null` clears the mute. */
export async function muteConversation(userId: string, conversationId: string, until: Date | null) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId }, select: { id: true, participant1: true, participant2: true },
  });
  if (!conv || (conv.participant1 !== userId && conv.participant2 !== userId)) throw notFound("Conversation not found");
  const data = isP1(conv, userId) ? { p1MutedUntil: until } : { p2MutedUntil: until };
  await prisma.conversation.update({ where: { id: conversationId }, data });
  return { conversationId, mutedUntil: until };
}

/** "Delete conversation for me" — hide messages before now for this side. */
export async function deleteConversationForMe(userId: string, conversationId: string) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId }, select: { id: true, participant1: true, participant2: true },
  });
  if (!conv || (conv.participant1 !== userId && conv.participant2 !== userId)) throw notFound("Conversation not found");
  const now = new Date();
  const data = isP1(conv, userId) ? { p1DeletedAt: now, p1UnreadCount: 0 } : { p2DeletedAt: now, p2UnreadCount: 0 };
  await prisma.conversation.update({ where: { id: conversationId }, data });
  return { ok: true };
}

/** Case-insensitive search within one conversation (body only, non-deleted). */
export async function searchConversation(userId: string, conversationId: string, q: string) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId }, select: { id: true, participant1: true, participant2: true, p1DeletedAt: true, p2DeletedAt: true },
  });
  if (!conv || (conv.participant1 !== userId && conv.participant2 !== userId)) throw notFound("Conversation not found");
  const term = q.trim();
  if (term.length < 1) return { data: [] };
  const since = isP1(conv, userId) ? conv.p1DeletedAt : conv.p2DeletedAt;
  const messages = await prisma.directMessage.findMany({
    where: {
      conversationId, deletedAt: null, body: { contains: term, mode: "insensitive" },
      ...(since ? { createdAt: { gt: since } } : {}),
      ...(isP1(conv, userId) ? { deletedForSender: false } : { deletedForRecipient: false }),
    },
    orderBy: { createdAt: "desc" }, take: 50,
    select: { id: true, senderId: true, body: true, createdAt: true },
  });
  return { data: messages };
}

export async function getConversationById(conversationId: string, userId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      user1: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      user2: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
    },
  });
  if (!conversation) throw notFound("Conversation not found");
  if (conversation.participant1 !== userId && conversation.participant2 !== userId) {
    throw forbidden("Not a participant in this conversation");
  }

  const otherUser = conversation.participant1 === userId ? conversation.user2 : conversation.user1;
  const recipientKey = await prisma.userPublicKey.findUnique({ where: { userId: otherUser.id } });

  return {
    id:        conversation.id,
    otherUser,
    publicKey: recipientKey?.publicKey ?? null,
    createdAt: conversation.createdAt,
  };
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export type SendMessageDto = {
  conversationId: string;
  senderId: string;
  // v2 server-readable content
  type?: "TEXT" | "IMAGE" | "VOICE" | "ANIME_CARD";
  body?: string;
  replyToId?: string;
  animeMalId?: number;
  animeEpisode?: number;
  clientNonce?: string;
  media?: {
    mediaUrl: string; mediaMime?: string; mediaSizeBytes?: number;
    mediaWidth?: number; mediaHeight?: number; mediaDurationS?: number; mediaBlurhash?: string;
  };
  // Legacy E2E path (kept until the mobile client migrates in Stage 5).
  ciphertext?: string;
  iv?: string;
  senderDeviceKeyId?: string;
  envelopes?: { recipientDeviceKeyId: string; wrappedKey: string; wrapIv: string }[];
};

const MSG_SELECT = {
  id: true, conversationId: true, senderId: true, type: true, body: true,
  mediaUrl: true, mediaMime: true, mediaSizeBytes: true, mediaWidth: true,
  mediaHeight: true, mediaDurationS: true, mediaBlurhash: true,
  animeMalId: true, animeEpisode: true, replyToId: true, clientNonce: true,
  ciphertext: true, iv: true, createdAt: true, readAt: true, deliveredAt: true,
  editedAt: true, deletedAt: true, senderDeviceKeyId: true,
} as const;

export async function sendMessage(opts: SendMessageDto) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: opts.conversationId },
    select: {
      id: true, participant1: true, participant2: true, status: true, initiatorId: true,
      p1MutedUntil: true, p2MutedUntil: true,
    },
  });
  // IDOR: non-existent OR not-a-participant both return 404 (no existence leak, §9.1).
  if (!conversation ||
      (conversation.participant1 !== opts.senderId && conversation.participant2 !== opts.senderId)) {
    throw notFound("Conversation not found");
  }

  const recipientId = otherOf(conversation, opts.senderId);

  // Block can happen mid-conversation — re-check on every send, both directions.
  if (await isBlockedEitherWay(opts.senderId, recipientId)) throw dmRejection();

  // Message-request (PENDING) rules.
  const isInitiator = conversation.initiatorId === opts.senderId;
  let promoteToActive = false;
  if (conversation.status === "PENDING") {
    if (isInitiator) {
      const sentSoFar = await prisma.directMessage.count({
        where: { conversationId: conversation.id, senderId: opts.senderId },
      });
      if (sentSoFar >= PENDING_INITIATOR_MAX) {
        throw forbidden("Message request limit reached until they reply");
      }
    } else {
      promoteToActive = true; // recipient replied → accept the request
    }
  } else if (conversation.status === "DECLINED") {
    if (isInitiator) throw dmRejection();   // silently stops; generic to initiator
    promoteToActive = true;                 // recipient re-opens
  }

  // Idempotent retry: return the existing message for a known nonce.
  if (opts.clientNonce) {
    const dup = await prisma.directMessage.findUnique({
      where: { conversationId_clientNonce: { conversationId: conversation.id, clientNonce: opts.clientNonce } },
      select: MSG_SELECT,
    });
    if (dup) return dup;
  }

  // Validate by type.
  const type = opts.type ?? (opts.body != null ? "TEXT" : opts.ciphertext ? "TEXT" : "TEXT");
  let body: string | null = null;
  const data: Record<string, unknown> = {};
  if (opts.ciphertext != null && opts.body == null) {
    // Legacy E2E path (back-compat).
    data.ciphertext = opts.ciphertext;
    data.iv = opts.iv ?? "";
    if (opts.senderDeviceKeyId) data.senderDeviceKeyId = opts.senderDeviceKeyId;
  } else if (type === "TEXT") {
    const raw = sanitizeBody(opts.body ?? "");
    if (raw.length < 1 || raw.length > 4000) throw badReq("Message must be 1–4000 characters");
    body = raw;
  } else if (type === "IMAGE" || type === "VOICE") {
    if (!opts.media?.mediaUrl || !isOurMediaUrl(opts.media.mediaUrl)) {
      throw badReq("Invalid media URL");
    }
    body = opts.body != null ? sanitizeBody(opts.body).slice(0, 4000) : null;
    Object.assign(data, opts.media);
  } else if (type === "ANIME_CARD") {
    if (!opts.animeMalId) throw badReq("animeMalId required");
    const anime = await prisma.anime.findUnique({ where: { malId: opts.animeMalId }, select: { id: true } });
    if (!anime) throw notFound("Anime not found");
    data.animeMalId = opts.animeMalId;
    if (opts.animeEpisode != null) data.animeEpisode = opts.animeEpisode;
    body = opts.body != null ? sanitizeBody(opts.body).slice(0, 4000) : null;
  }

  // Validate reply target belongs to the same conversation.
  if (opts.replyToId) {
    const parent = await prisma.directMessage.findUnique({
      where: { id: opts.replyToId }, select: { conversationId: true },
    });
    if (!parent || parent.conversationId !== conversation.id) throw badReq("Invalid replyToId");
    data.replyToId = opts.replyToId;
  }

  const recipientOnline = isOnline(recipientId);
  const recipientFocused = isViewing(recipientId, conversation.id);
  const now = new Date();
  const recipientIsP1 = isP1(conversation, recipientId);
  const unreadField = recipientIsP1 ? "p1UnreadCount" : "p2UnreadCount";

  // Transaction: create message → update conversation preview/status/unread.
  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.directMessage.create({
      data: {
        conversationId: conversation.id,
        senderId: opts.senderId,
        type,
        ...(body != null ? { body } : {}),
        ...(opts.clientNonce ? { clientNonce: opts.clientNonce } : {}),
        ...(recipientOnline ? { deliveredAt: now } : {}),
        ...data,
      },
      select: MSG_SELECT,
    });
    await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: now,
        updatedAt: now,
        ...(promoteToActive ? { status: "ACTIVE" } : {}),
        // Suppress unread bump while the recipient is actively viewing the chat.
        ...(recipientFocused ? {} : { [unreadField]: { increment: 1 } }),
      },
    });
    if (opts.envelopes?.length) {
      await tx.messageKeyEnvelope.createMany({
        data: opts.envelopes.map((e) => ({
          messageId: created.id, recipientDeviceKeyId: e.recipientDeviceKeyId,
          wrappedKey: e.wrappedKey, wrapIv: e.wrapIv,
        })),
        skipDuplicates: true,
      });
    }
    return created;
  });

  // Real-time fan-out behind the realtime layer.
  const io = getIo();
  if (io) {
    io.to(`user:${recipientId}`).emit("chat.message", { ...message, envelopes: opts.envelopes ?? [] });
    io.to(`user:${opts.senderId}`).emit("chat.sent", { nonce: opts.clientNonce ?? null, message });
    if (recipientOnline) {
      io.to(`user:${opts.senderId}`).emit("chat.delivered", { conversationId: conversation.id, messageId: message.id, deliveredAt: now });
    }
  }

  // Push when recipient is offline/unfocused and the conversation isn't muted.
  const recipientMutedUntil = recipientIsP1 ? conversation.p1MutedUntil : conversation.p2MutedUntil;
  const muted = recipientMutedUntil != null && recipientMutedUntil.getTime() > now.getTime();
  const firstPendingMessage = conversation.status === "PENDING" && isInitiator;
  if (!recipientOnline && !recipientFocused && !muted) {
    void notifyRecipientPush(opts.senderId, recipientId, conversation.id, {
      preview: previewForPush(message),
      firstPendingMessage,
    }).catch(() => {});
  }

  return message;
}

/** Short push preview, respecting media/anime types and never leaking on PENDING. */
function previewForPush(m: { type: string; body: string | null }): string {
  if (m.type === "IMAGE") return "sent a photo";
  if (m.type === "VOICE") return "sent a voice message";
  if (m.type === "ANIME_CARD") return "shared an anime";
  return (m.body ?? "Sent you a message").slice(0, 80);
}

async function notifyRecipientPush(
  senderId: string,
  recipientId: string,
  conversationId: string,
  opts?: { preview?: string; firstPendingMessage?: boolean },
) {
  const sender = await prisma.user.findUnique({
    where: { id: senderId },
    select: { username: true, displayName: true },
  });
  const senderName = sender?.displayName || sender?.username || "New message";
  const replyToken = jwt.sign(
    { typ: "push-reply", uid: recipientId, cid: conversationId },
    env.JWT_ACCESS_SECRET,
    { expiresIn: "24h" },
  );
  // Unread tallies ride along so the notification can show real numbers
  // (launcher badge + "N new messages" body).
  const [totalUnread, convUnread] = await Promise.all([
    prisma.directMessage.count({
      where: {
        senderId: { not: recipientId },
        readAt: null,
        conversation: { OR: [{ participant1: recipientId }, { participant2: recipientId }] },
      },
    }),
    prisma.directMessage.count({
      where: { conversationId, senderId: { not: recipientId }, readAt: null },
    }),
  ]);
  // PENDING requests notify ONLY on the first message, with a generic body.
  const body = opts?.firstPendingMessage
    ? "wants to send you a message"
    : convUnread > 1
      ? `${convUnread} new messages`
      : opts?.preview ?? "Sent you a message";
  await pushToUser(recipientId, {
    title: senderName,
    body,
    data: {
      type: "dm", conversationId, senderName, replyToken,
      badge: String(totalUnread), convUnread: String(convUnread),
    },
  });
}

/**
 * Inline reply from an Android notification. Authenticated by the short-lived
 * reply token minted in notifyRecipientPush — no session stored natively.
 * Replies ride the legacy plain-marker path ("PLAIN_NO_E2E"), which every
 * client decodes, so they interoperate with the E2E envelope path.
 */
export async function sendPushReply(token: string, content: string) {
  let claims: { typ?: string; uid?: string; cid?: string };
  try {
    claims = jwt.verify(token, env.JWT_ACCESS_SECRET) as typeof claims;
  } catch {
    throw forbidden("Invalid or expired reply token");
  }
  if (claims.typ !== "push-reply" || !claims.uid || !claims.cid) {
    throw forbidden("Invalid reply token");
  }
  return sendMessage({
    conversationId: claims.cid,
    senderId: claims.uid,
    type: "TEXT",
    body: content,
  });
}

export async function getMessages(opts: {
  conversationId: string;
  userId: string;
  cursor?: string;
  limit: number;
}) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: opts.conversationId },
    select: { id: true, participant1: true, participant2: true, p1DeletedAt: true, p2DeletedAt: true },
  });
  // IDOR → 404 (no existence leak).
  if (!conversation ||
      (conversation.participant1 !== opts.userId && conversation.participant2 !== opts.userId)) {
    throw notFound("Conversation not found");
  }
  // "Delete conversation for me" hides everything before that cutoff for this side.
  const clearedAt = isP1(conversation, opts.userId) ? conversation.p1DeletedAt : conversation.p2DeletedAt;

  // The requester's device key ids — used to return only the envelopes wrapped
  // for THIS user's devices (the client picks the one for its current device).
  const myDeviceKeys = await prisma.userDeviceKey.findMany({
    where:  { userId: opts.userId },
    select: { id: true },
  });
  const myKeyIds = myDeviceKeys.map((d) => d.id);

  // Filter out messages the requester has "deleted for me" (still visible to
  // the other participant). Messages deleted "for everyone" are returned with
  // deletedAt set, so the client renders a tombstone for both users.
  const messages = await prisma.directMessage.findMany({
    where: {
      conversationId: opts.conversationId,
      ...(opts.cursor ? { createdAt: { lt: new Date(opts.cursor) } } : {}),
      ...(clearedAt ? { createdAt: { gt: clearedAt } } : {}),
      OR: [
        { senderId: opts.userId,           deletedForSender:    false },
        { senderId: { not: opts.userId },  deletedForRecipient: false },
      ],
    },
    orderBy: { createdAt: "desc" },
    take:    opts.limit + 1,
    select:  {
      id:        true,
      senderId:  true,
      type:      true,
      body:      true,
      mediaUrl: true, mediaMime: true, mediaSizeBytes: true, mediaWidth: true,
      mediaHeight: true, mediaDurationS: true, mediaBlurhash: true,
      animeMalId: true, animeEpisode: true, replyToId: true, editedAt: true,
      ciphertext: true,
      iv:        true,
      createdAt: true,
      readAt:    true,
      deliveredAt: true,
      deletedAt: true,
      senderDeviceKeyId: true,
      replyTo: { select: { id: true, senderId: true, type: true, body: true, deletedAt: true } },
      // Only the envelopes addressed to this user's device(s) (empty for legacy).
      envelopes: {
        where:  { recipientDeviceKeyId: { in: myKeyIds } },
        select: { recipientDeviceKeyId: true, wrappedKey: true, wrapIv: true },
      },
      reactions: { select: { emoji: true, userId: true } },
    },
  });

  const hasMore = messages.length > opts.limit;
  const items   = hasMore ? messages.slice(0, opts.limit) : messages;

  // Aggregate reactions per message → [{ emoji, count, reactedByMe }].
  const withReactions = items.map((m) => {
    const byEmoji = new Map<string, { emoji: string; count: number; reactedByMe: boolean }>();
    for (const r of m.reactions) {
      const e = byEmoji.get(r.emoji) ?? { emoji: r.emoji, count: 0, reactedByMe: false };
      e.count += 1;
      if (r.userId === opts.userId) e.reactedByMe = true;
      byEmoji.set(r.emoji, e);
    }
    return { ...m, reactions: [...byEmoji.values()] };
  });

  return {
    messages:   withReactions,
    nextCursor: hasMore ? items[items.length - 1].createdAt.toISOString() : null,
  };
}

// ─── Reactions ─────────────────────────────────────────────────────────────────
async function assertParticipantForMessage(messageId: string, userId: string) {
  const msg = await prisma.directMessage.findUnique({
    where: { id: messageId },
    select: {
      conversationId: true,
      conversation: { select: { participant1: true, participant2: true } },
    },
  });
  if (!msg) throw notFound("Message not found");
  if (msg.conversation.participant1 !== userId && msg.conversation.participant2 !== userId) {
    throw forbidden("Not a participant in this conversation");
  }
  return msg;
}

function emitReaction(
  msg: { conversationId: string; conversation: { participant1: string; participant2: string } },
  payload: { messageId: string; userId: string; emoji: string; op: "set" | "remove"; prevEmoji?: string | null },
) {
  const io = getIo();
  if (!io) return;
  // Both participants (covers the actor's other devices too)
  io.to(`user:${msg.conversation.participant1}`)
    .to(`user:${msg.conversation.participant2}`)
    .emit("chat.reaction", { ...payload, conversationId: msg.conversationId });
}

export async function addReaction(userId: string, messageId: string, emoji: string) {
  const msg = await assertParticipantForMessage(messageId, userId);
  // Previous emoji (if any) rides on the socket event so clients can patch
  // their aggregate counts without a refetch.
  const prev = await prisma.messageReaction.findFirst({
    where: { messageId, userId },
    select: { emoji: true },
  });
  // WhatsApp model: ONE reaction per user per message — picking a new emoji
  // replaces the previous one atomically.
  await prisma.$transaction([
    prisma.messageReaction.deleteMany({ where: { messageId, userId, NOT: { emoji } } }),
    prisma.messageReaction.upsert({
      where:  { messageId_userId_emoji: { messageId, userId, emoji } },
      create: { messageId, userId, emoji },
      update: {},
    }),
  ]);
  emitReaction(msg, { messageId, userId, emoji, op: "set", prevEmoji: prev?.emoji ?? null });
  return { ok: true };
}

export async function removeReaction(userId: string, messageId: string, emoji: string) {
  const msg = await assertParticipantForMessage(messageId, userId);
  await prisma.messageReaction.deleteMany({ where: { messageId, userId, emoji } });
  emitReaction(msg, { messageId, userId, emoji, op: "remove" });
  return { ok: true };
}

/** Remove whatever reaction the user has on a message (PUT { emoji: null }). */
export async function clearReaction(userId: string, messageId: string) {
  const msg = await assertParticipantForMessage(messageId, userId);
  const existing = await prisma.messageReaction.findFirst({ where: { messageId, userId }, select: { emoji: true } });
  if (!existing) return { ok: true };
  await prisma.messageReaction.deleteMany({ where: { messageId, userId } });
  emitReaction(msg, { messageId, userId, emoji: existing.emoji, op: "remove" });
  return { ok: true };
}

export async function markConversationRead(conversationId: string, userId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, participant1: true, participant2: true },
  });
  // IDOR → 404 (no existence leak).
  if (!conversation ||
      (conversation.participant1 !== userId && conversation.participant2 !== userId)) {
    throw notFound("Conversation not found");
  }

  const now = new Date();
  const meIsP1 = isP1(conversation, userId);
  const otherUserId = otherOf(conversation, userId);

  await prisma.$transaction([
    prisma.directMessage.updateMany({
      where: { conversationId, senderId: { not: userId }, readAt: null },
      data: { readAt: now },
    }),
    prisma.conversation.update({
      where: { id: conversationId },
      data: meIsP1
        ? { p1UnreadCount: 0, p1LastReadAt: now }
        : { p2UnreadCount: 0, p2LastReadAt: now },
    }),
  ]);

  // Read receipts are mutual: only emit dm:read if BOTH the reader and the
  // other party have read receipts enabled (security §3, spec §2.markRead).
  const [me, other] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { readReceiptsOn: true } }),
    prisma.user.findUnique({ where: { id: otherUserId }, select: { readReceiptsOn: true } }),
  ]);
  const blocked = await isBlockedEitherWay(userId, otherUserId);
  if (me?.readReceiptsOn && other?.readReceiptsOn && !blocked) {
    getIo()?.to(`user:${otherUserId}`).emit("chat.read", { conversationId, readAt: now });
  }

  return { conversationId, readAt: now };
}

// ─── Edit / requests ──────────────────────────────────────────────────────────

/** Sender-only, TEXT-only, within 15 min, not deleted. Emits chat.edited. */
export async function editMessage(userId: string, messageId: string, newBody: string) {
  const msg = await prisma.directMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true, senderId: true, conversationId: true, type: true, createdAt: true, deletedAt: true,
      conversation: { select: { participant1: true, participant2: true } },
    },
  });
  if (!msg) throw notFound("Message not found");
  if (msg.senderId !== userId) throw forbidden("Only the sender can edit");
  if (msg.type !== "TEXT") throw badReq("Only text messages can be edited");
  if (msg.deletedAt) throw badReq("Cannot edit a deleted message");
  if (Date.now() - msg.createdAt.getTime() > EDIT_WINDOW_MS) throw forbidden("Edit window has passed");
  const body = sanitizeBody(newBody);
  if (body.length < 1 || body.length > 4000) throw badReq("Message must be 1–4000 characters");

  const now = new Date();
  await prisma.directMessage.update({ where: { id: messageId }, data: { body, editedAt: now } });
  const io = getIo();
  if (io) {
    io.to(`user:${msg.conversation.participant1}`)
      .to(`user:${msg.conversation.participant2}`)
      .emit("chat.edited", { conversationId: msg.conversationId, messageId, body, editedAt: now });
  }
  return { id: messageId, body, editedAt: now };
}

/** Recipient accepts a pending message request → ACTIVE. */
export async function acceptRequest(userId: string, conversationId: string) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, participant1: true, participant2: true, status: true, initiatorId: true },
  });
  if (!conv || (conv.participant1 !== userId && conv.participant2 !== userId)) throw notFound("Conversation not found");
  if (conv.initiatorId === userId) throw forbidden("Only the recipient can accept");
  await prisma.conversation.update({ where: { id: conversationId }, data: { status: "ACTIVE" } });
  getIo()?.to(`user:${conv.initiatorId ?? ""}`).to(`user:${userId}`)
    .emit("chat.conversation-update", { conversationId, status: "ACTIVE" });
  return { conversationId, status: "ACTIVE" as const };
}

/** Recipient declines → DECLINED (initiator is NOT notified, §2). */
export async function declineRequest(userId: string, conversationId: string) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, participant1: true, participant2: true, initiatorId: true },
  });
  if (!conv || (conv.participant1 !== userId && conv.participant2 !== userId)) throw notFound("Conversation not found");
  if (conv.initiatorId === userId) throw forbidden("Only the recipient can decline");
  await prisma.conversation.update({ where: { id: conversationId }, data: { status: "DECLINED" } });
  // Notify only the decliner's own devices; initiator gets nothing.
  getIo()?.to(`user:${userId}`).emit("chat.conversation-update", { conversationId, status: "DECLINED" });
  return { conversationId, status: "DECLINED" as const };
}

// ─── Delete message (WhatsApp-style) ──────────────────────────────────────────

const DELETE_FOR_EVERYONE_WINDOW_MS = 24 * 60 * 60 * 1000  // 24 hours

export type DeleteScope = "me" | "everyone"

/**
 * Delete a message.
 *   scope=me:        hide from the caller only; other side still sees it
 *   scope=everyone:  only the sender can, only within 24h; both sides see tombstone
 *
 * Emits chat.deleted via socket so the other participant's UI updates live.
 */
export async function deleteMessage(opts: {
  conversationId: string
  messageId:      string
  userId:         string
  scope:          DeleteScope
}) {
  const conv = await prisma.conversation.findUnique({
    where: { id: opts.conversationId },
    select: { id: true, participant1: true, participant2: true },
  })
  if (!conv) throw notFound("Conversation not found")
  if (conv.participant1 !== opts.userId && conv.participant2 !== opts.userId) {
    throw forbidden("Not a participant in this conversation")
  }

  const msg = await prisma.directMessage.findUnique({
    where:  { id: opts.messageId },
    select: { id: true, senderId: true, conversationId: true, createdAt: true, deletedAt: true },
  })
  if (!msg || msg.conversationId !== opts.conversationId) throw notFound("Message not found")

  const otherUserId = conv.participant1 === opts.userId ? conv.participant2 : conv.participant1
  const isSender    = msg.senderId === opts.userId

  if (opts.scope === "everyone") {
    if (!isSender)                                              throw forbidden("Only the sender can delete for everyone")
    if (msg.deletedAt)                                          return { ok: true, scope: "everyone" as const }
    const age = Date.now() - msg.createdAt.getTime()
    if (age > DELETE_FOR_EVERYONE_WINDOW_MS)                    throw forbidden("You can only delete for everyone within 24 hours")

    await prisma.directMessage.update({
      where: { id: msg.id },
      data: {
        deletedAt: new Date(),
        // Null all content so it can't be recovered from the DB (body, media,
        // and any legacy ciphertext). Clients render a tombstone for both sides.
        body: null,
        ciphertext: null,
        iv: null,
        mediaUrl: null, mediaMime: null, mediaBlurhash: null,
      },
    })

    // Notify the other participant live
    const io = getIo()
    if (io) io.to(`user:${otherUserId}`).emit("chat.deleted", { conversationId: conv.id, messageId: msg.id, scope: "everyone" })

    return { ok: true, scope: "everyone" as const }
  }

  // scope === "me" — hide from this side only
  await prisma.directMessage.update({
    where: { id: msg.id },
    data: isSender
      ? { deletedForSender:    true }
      : { deletedForRecipient: true },
  })

  return { ok: true, scope: "me" as const }
}
