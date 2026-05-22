import { z } from "zod";

export const askSchema = z.object({
  prompt: z.string().min(1).max(2000),
  context: z
    .object({
      animeId: z.string().optional(),
      conversationId: z.string().optional(),
    })
    .optional(),
});
