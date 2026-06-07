import { z } from "zod";

export const createShotSchema = z.object({
  videoUrl: z.string().url().max(500),
  thumbnailUrl: z.string().url().max(500).optional(),
  caption: z.string().max(2200).optional(),
  durationMs: z.number().int().positive().max(5 * 60 * 1000).optional(),
  animeId: z.string().optional(),
});

export type CreateShotDto = z.infer<typeof createShotSchema>;
