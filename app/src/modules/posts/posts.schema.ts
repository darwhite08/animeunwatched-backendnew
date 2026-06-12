import { z } from "zod";

export const createPostSchema = z.object({
  content: z.string().min(1).max(5000),
  animeId: z.string().optional(),
  imageUrl: z.string().url().max(500).optional(),
  imageUrls: z.array(z.string().url().max(500)).max(10).optional(),
  galleryLayout: z.enum(["grid", "carousel"]).optional(),
});

export const createCommentSchema = z.object({
  content: z.string().min(1).max(2000),
  parentCommentId: z.string().optional(),
});

export type CreatePostDto = z.infer<typeof createPostSchema>;
export type CreateCommentDto = z.infer<typeof createCommentSchema>;
