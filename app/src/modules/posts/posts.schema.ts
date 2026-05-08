import { z } from "zod";

export const createPostSchema = z.object({
  content: z.string().min(1).max(5000),
  animeId: z.string().optional(),
});

export const createCommentSchema = z.object({
  content: z.string().min(1).max(2000),
});

export type CreatePostDto = z.infer<typeof createPostSchema>;
export type CreateCommentDto = z.infer<typeof createCommentSchema>;
