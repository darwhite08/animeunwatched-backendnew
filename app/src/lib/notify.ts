import { prisma } from "../config/prisma";
// io will be passed in or imported from a global

export async function createNotification(opts: {
  recipientId: string;
  type: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await prisma.notification.create({
    data: {
      recipientId: opts.recipientId,
      type: opts.type,
      payload: opts.payload,
    },
  });
  // TODO: emit socket event when io instance is accessible
  // For now, just create the DB record
}
