import { z } from "zod";

export const reportSchema = z.object({
  body: z.object({
    conversationId: z.string().min(1),
    messageId: z.string().min(1).optional(),
    reason: z.enum(["spam", "harassment", "nsfw", "other"]),
    details: z.string().max(2000).optional(),
  }),
});
