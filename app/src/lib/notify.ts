import { prisma } from "../config/prisma";
import { getIo } from "../realtime/io-instance";

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
}
