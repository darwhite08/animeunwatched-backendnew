import { z } from "zod";

export const reportSchema = z.object({
  body: z.object({
    conversationId: z.string().min(1),
    messageId: z.string().min(1).optional(),
    reason: z.enum(["spam", "harassment", "nsfw", "other"]),
    details: z.string().max(2000).optional(),
    // E2EE franking evidence (spec §5): the reporter decrypts the messages and
    // submits plaintext + per-message frankingKey so the server can verify the
    // content is genuine and unaltered, without ever reading the chat itself.
    evidence: z.array(z.object({
      messageId: z.string().min(1),
      plaintext: z.string().max(8000),
      frankingKey: z.string().min(1).max(512),
    })).max(50).optional(),
  }),
});
