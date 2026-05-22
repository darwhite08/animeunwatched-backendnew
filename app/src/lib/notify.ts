import { prisma } from "../config/prisma";
import { getIo } from "../realtime/io-instance";
import { pushToUser } from "./push";

export const NotificationType = {
  MENTION:         "mention",
  NEW_FOLLOWER:    "new_follower",
  REVIEW_LIKED:    "review_liked",
  POST_LIKED:      "post_liked",
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
    case "streak_reminder": return "Your streak is at risk";
    case "achievement":     return "Achievement unlocked";
    case "system":          return "Kaiveron";
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
