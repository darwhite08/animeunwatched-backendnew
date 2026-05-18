import { prisma } from "../../config/prisma";
import { getIo } from "../../realtime/io-instance";
import { notFound, forbidden } from "../../lib/errors";

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

  return conversations.map((conv) => {
    const otherUser = conv.participant1 === userId ? conv.user2 : conv.user1;
    const lastMessage = conv.messages[0] ?? null;

    return {
      id:          conv.id,
      otherUser,
      lastMessage,
      updatedAt:   conv.updatedAt,
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
    },
    select: {
      id:             true,
      conversationId: true,
      senderId:       true,
      ciphertext:     true,
      iv:             true,
      createdAt:      true,
      readAt:         true,
    },
  });

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
    io.to(`user:${recipientId}`).emit("chat.message", message);
  }

  return message;
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

  const messages = await prisma.directMessage.findMany({
    where: {
      conversationId: opts.conversationId,
      ...(opts.cursor ? { createdAt: { lt: new Date(opts.cursor) } } : {}),
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
    },
  });

  const hasMore = messages.length > opts.limit;
  const items   = hasMore ? messages.slice(0, opts.limit) : messages;

  return {
    messages:   items,
    nextCursor: hasMore ? items[items.length - 1].createdAt.toISOString() : null,
  };
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
