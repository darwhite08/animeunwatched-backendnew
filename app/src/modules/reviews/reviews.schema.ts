import { z } from "zod";

export const createReviewSchema = z.object({
  animeId:     z.string().min(1),
  score:       z.number().int().min(1).max(10),
  body:        z.string().min(20).max(10000),
  hasSpoilers: z.boolean().optional(),
});

export const updateReviewSchema = z.object({
  score:       z.number().int().min(1).max(10).optional(),
  body:        z.string().min(20).max(10000).optional(),
  hasSpoilers: z.boolean().optional(),
});

export type CreateReviewDto = z.infer<typeof createReviewSchema>;
export type UpdateReviewDto = z.infer<typeof updateReviewSchema>;
