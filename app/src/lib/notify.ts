import { prisma } from "../config/prisma";

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
  await prisma.notification.create({
    data: {
      recipientId: opts.recipientId,
      type: opts.type,
      payload: opts.payload as Record<string, unknown>,
    },
  });
  // TODO: emit socket event when io instance is accessible
  // For now, just create the DB record
}
