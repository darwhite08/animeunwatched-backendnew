import { prisma } from "../config/prisma";
import { getIo } from "../realtime/io-instance";
import { pushToUser } from "./push";

export const NotificationType = {
  MENTION:         "mention",
  NEW_FOLLOWER:    "new_follower",
  REVIEW_LIKED:    "review_liked",
  POST_LIKED:      "post_liked",
  POST_COMMENT:    "post_comment",
  MESSAGE:         "message",
  STREAK_REMINDER: "streak_reminder",
  ACHIEVEMENT:     "achievement",
  SYSTEM:          "system",
} as const;

export type NotificationTypeValue = (typeof NotificationType)[keyof typeof NotificationType];

export type NotifPayload = { message: string; link?: string; [key: string]: unknown };

function shortTitle(type: NotificationTypeValue): string {
  switch (type) {
    case "mention":         return "You were mentioned";
    case "new_follower":    return "New follower";
    case "review_liked":    return "Someone liked your review";
    case "post_liked":      return "Someone liked your post";
    case "post_comment":    return "New comment on your post";
    case "message":         return "New message";
    case "streak_reminder": return "Your streak is at risk";
    case "achievement":     return "Achievement unlocked";
    case "system":          return "Kaiveron";
  }
}

/**
 * Collapsed DM notification: one row per (recipient, conversation), bumped on
 * every message instead of a new row per message. Attributed to the real sender
 * (name + avatar), content-free (E2EE-safe), links to the conversation. Push is
 * tagged per-conversation so the OS replaces rather than stacks, and does NOT
 * renotify on every message from an already-notified sender.
 */
export async function bumpDmNotification(opts: {
  recipientId: string;
  conversationId: string;
  senderName: string;
  senderUsername?: string | null;
  senderAvatarUrl?: string | null;
}): Promise<void> {
  const groupKey = `dm:${opts.conversationId}`;
  const link = `/chat/${opts.conversationId}`;
  const basePayload = {
    message: `${opts.senderName} sent you a message`,
    link,
    conversationId: opts.conversationId,
    actorUsername: opts.senderUsername ?? undefined,
    actorDisplayName: opts.senderName,
    actorAvatarUrl: opts.senderAvatarUrl ?? null,
  };

  // Atomic upsert-and-increment, then rewrite the message with the fresh count.
  const bumped = await prisma.notification.upsert({
    where: { recipientId_groupKey: { recipientId: opts.recipientId, groupKey } },
    create: { recipientId: opts.recipientId, type: NotificationType.MESSAGE, groupKey, count: 1, payload: basePayload as unknown as import("@prisma/client/runtime/library").InputJsonValue },
    update: { count: { increment: 1 }, read: false },
  });
  const count = bumped.count;
  const message = count > 1 ? `${opts.senderName} sent you ${count} messages` : `${opts.senderName} sent you a message`;
  const notification = await prisma.notification.update({
    where: { id: bumped.id },
    data: { payload: { ...basePayload, message } as unknown as import("@prisma/client/runtime/library").InputJsonValue },
  });

  const io = getIo();
  if (io) {
    io.to(`user:${opts.recipientId}`).emit("notification.new", {
      id: notification.id, type: notification.type, payload: notification.payload,
      read: notification.read, createdAt: notification.createdAt,
    });
  }

  void pushToUser(opts.recipientId, {
    title: opts.senderName,
    body: count > 1 ? `${count} new messages` : "New message",
    data: { type: NotificationType.MESSAGE, tag: groupKey, renotify: false, notificationId: notification.id, link },
  }).catch((err) => console.error("[notify] dm push failed", err));
}

/** Zero a conversation's grouped DM notification (recipient opened the chat). */
export async function clearDmNotification(recipientId: string, conversationId: string): Promise<void> {
  const groupKey = `dm:${conversationId}`;
  const res = await prisma.notification.updateMany({
    where: { recipientId, groupKey, read: false },
    data: { read: true, count: 0 },
  });
  if (res.count > 0) {
    const io = getIo();
    io?.to(`user:${recipientId}`).emit("notification.read", { groupKey, conversationId });
  }
}

export async function createNotification(opts: {
  recipientId: string;
  type: NotificationTypeValue;
  payload: NotifPayload;
}): Promise<void> {
  const notification = await prisma.notification.create({
    data: {
      recipientId: opts.recipientId,
      type: opts.type,
      payload: opts.payload as unknown as import("@prisma/client/runtime/library").InputJsonValue,
    },
  });

  const io = getIo();
  if (io) {
    io.to(`user:${opts.recipientId}`).emit("notification.new", {
      id:          notification.id,
      type:        notification.type,
      payload:     notification.payload,
      read:        notification.read,
      createdAt:   notification.createdAt,
    });
  }

  // Best-effort push dispatch — never block the originating request on this.
  void pushToUser(opts.recipientId, {
    title: shortTitle(opts.type),
    body: opts.payload.message,
    data: {
      type: opts.type,
      notificationId: notification.id,
      link: opts.payload.link,
      ...opts.payload,
    },
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[notify] push dispatch failed", err);
  });
}
