import { z } from "zod";

export const createStorySchema = z.object({
  mediaUrl: z.string().url().max(500),
  mediaType: z.enum(["image", "video"]),
  caption: z.string().max(500).optional(),
});

export type CreateStoryDto = z.infer<typeof createStorySchema>;
