import jwt from "jsonwebtoken";
import { prisma } from "../../config/prisma";
import { getIo } from "../../realtime/io-instance";
import { notFound, forbidden } from "../../lib/errors";
import { env } from "../../config/env";
import { pushToUser } from "../../lib/push";

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
    const { conflict } = await import("../../lib/errors");
    throw conflict("Cannot start a conversation with yourself");
  }

  // Ensure the recipient exists
  const recipient = await prisma.user.findUnique({
    where:  { id: recipientId },
    select: { id: true, username: true, displayName: true, avatarUrl: true },
  });
  if (!recipient) throw notFound("User not found");

  // Canonical ordering: smaller id is participant1
  const [p1, p2] = [callerId, recipientId].sort();

  const conversation = await prisma.conversation.upsert({
    where:  { participant1_participant2: { participant1: p1, participant2: p2 } },
    create: { participant1: p1, participant2: p2 },
    update: { updatedAt: new Date() },
    select: {
      id: true,
      participant1: true,
      participant2: true,
      createdAt: true,
    },
  });

  // Fetch other user's public key (may be null if they haven't uploaded one yet)
  const recipientKey = await prisma.userPublicKey.findUnique({
    where: { userId: recipientId },
  });

  return {
    id:          conversation.id,
    otherUser:   recipient,
    publicKey:   recipientKey?.publicKey ?? null,
    createdAt:   conversation.createdAt,
  };
}

export async function listConversations(userId: string) {
  const conversations = await prisma.conversation.findMany({
    where: {
      OR: [{ participant1: userId }, { participant2: userId }],
    },
    orderBy: { updatedAt: "desc" },
    include: {
      user1: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      user2: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          senderId: true,
          ciphertext: true,
          iv: true,
          createdAt: true,
          readAt: true,
        },
      },
    },
  });

  // Per-conversation unread counts (messages to me that I haven't read) —
  // one grouped query for the whole list, not N+1.
  const unread = await prisma.directMessage.groupBy({
    by: ["conversationId"],
    where: {
      conversationId: { in: conversations.map((c) => c.id) },
      senderId: { not: userId },
      readAt: null,
    },
    _count: { _all: true },
  });
  const unreadMap = new Map(unread.map((u) => [u.conversationId, u._count._all]));

  return conversations.map((conv) => {
    const otherUser = conv.participant1 === userId ? conv.user2 : conv.user1;
    const lastMessage = conv.messages[0] ?? null;

    return {
      id:          conv.id,
      otherUser,
      lastMessage,
      updatedAt:   conv.updatedAt,
      unreadCount: unreadMap.get(conv.id) ?? 0,
    };
  });
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

export async function sendMessage(opts: {
  conversationId: string;
  senderId: string;
  ciphertext: string;
  iv: string;
  // Multi-device E2E (optional, additive). When present, ciphertext is encrypted
  // with a random per-message key wrapped per recipient device in `envelopes`.
  senderDeviceKeyId?: string;
  envelopes?: { recipientDeviceKeyId: string; wrappedKey: string; wrapIv: string }[];
}) {
  // Verify caller is a participant
  const conversation = await prisma.conversation.findUnique({
    where: { id: opts.conversationId },
  });
  if (!conversation) throw notFound("Conversation not found");
  if (conversation.participant1 !== opts.senderId && conversation.participant2 !== opts.senderId) {
    throw forbidden("Not a participant in this conversation");
  }

  const message = await prisma.directMessage.create({
    data: {
      conversationId: opts.conversationId,
      senderId:       opts.senderId,
      ciphertext:     opts.ciphertext,
      iv:             opts.iv,
      ...(opts.senderDeviceKeyId ? { senderDeviceKeyId: opts.senderDeviceKeyId } : {}),
    },
    select: {
      id:               true,
      conversationId:   true,
      senderId:         true,
      ciphertext:       true,
      iv:               true,
      createdAt:        true,
      readAt:           true,
      senderDeviceKeyId: true,
    },
  });

  // Store per-device key envelopes (E2E). Legacy messages send none.
  if (opts.envelopes?.length) {
    await prisma.messageKeyEnvelope.createMany({
      data: opts.envelopes.map((e) => ({
        messageId:            message.id,
        recipientDeviceKeyId: e.recipientDeviceKeyId,
        wrappedKey:           e.wrappedKey,
        wrapIv:               e.wrapIv,
      })),
      skipDuplicates: true,
    });
  }

  // Update conversation timestamp
  await prisma.conversation.update({
    where: { id: opts.conversationId },
    data:  { updatedAt: new Date() },
  });

  // Emit to recipient via Socket.io
  const recipientId =
    conversation.participant1 === opts.senderId
      ? conversation.participant2
      : conversation.participant1;

  const io = getIo();
  if (io) {
    // Include envelopes so the recipient can decrypt the live message without a refetch.
    io.to(`user:${recipientId}`).emit("chat.message", { ...message, envelopes: opts.envelopes ?? [] });
  }

  // Fire-and-forget native push so the recipient sees it in the system tray.
  // Content is E2E-encrypted server-side, so the body stays generic. A
  // short-lived reply token rides along so the Android notification can offer
  // inline reply without storing credentials natively.
  void notifyRecipientPush(opts.senderId, recipientId, opts.conversationId).catch(() => {});

  return message;
}

async function notifyRecipientPush(senderId: string, recipientId: string, conversationId: string) {
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
  await pushToUser(recipientId, {
    title: senderName,
    body: "Sent you a secure message",
    data: { type: "dm", conversationId, senderName, replyToken },
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
  const ciphertext = Buffer.from(content, "utf8").toString("base64");
  return sendMessage({
    conversationId: claims.cid,
    senderId: claims.uid,
    ciphertext,
    iv: "PLAIN_NO_E2E",
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
  });
  if (!conversation) throw notFound("Conversation not found");
  if (conversation.participant1 !== opts.userId && conversation.participant2 !== opts.userId) {
    throw forbidden("Not a participant in this conversation");
  }

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
      ciphertext: true,
      iv:        true,
      createdAt: true,
      readAt:    true,
      deletedAt: true,
      senderDeviceKeyId: true,
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
    select: { conversation: { select: { participant1: true, participant2: true } } },
  });
  if (!msg) throw notFound("Message not found");
  if (msg.conversation.participant1 !== userId && msg.conversation.participant2 !== userId) {
    throw forbidden("Not a participant in this conversation");
  }
}

export async function addReaction(userId: string, messageId: string, emoji: string) {
  await assertParticipantForMessage(messageId, userId);
  await prisma.messageReaction.upsert({
    where:  { messageId_userId_emoji: { messageId, userId, emoji } },
    create: { messageId, userId, emoji },
    update: {},
  });
  return { ok: true };
}

export async function removeReaction(userId: string, messageId: string, emoji: string) {
  await assertParticipantForMessage(messageId, userId);
  await prisma.messageReaction.deleteMany({ where: { messageId, userId, emoji } });
  return { ok: true };
}

export async function markConversationRead(conversationId: string, userId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
  });
  if (!conversation) throw notFound("Conversation not found");
  if (conversation.participant1 !== userId && conversation.participant2 !== userId) {
    throw forbidden("Not a participant in this conversation");
  }

  const now = new Date();

  await prisma.directMessage.updateMany({
    where: {
      conversationId,
      senderId: { not: userId },
      readAt:   null,
    },
    data: { readAt: now },
  });

  // Tell the other user their messages were read
  const otherUserId =
    conversation.participant1 === userId
      ? conversation.participant2
      : conversation.participant1;

  const io = getIo();
  if (io) {
    io.to(`user:${otherUserId}`).emit("chat.read", {
      conversationId,
      readAt: now,
    });
  }

  return { conversationId, readAt: now };
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
        // Clear the ciphertext so the message content can't be recovered from the DB
        ciphertext: "",
        iv:         "",
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
