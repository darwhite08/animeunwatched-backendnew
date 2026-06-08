import { z } from "zod";

export const createBlogSchema = z.object({
  title:  z.string().min(1).max(200),
  body:   z.string().min(1).max(200_000),
  status: z.enum(["DRAFT", "SCHEDULED", "PUBLISHED"]).optional(),
  scheduledAt: z.string().datetime().optional(),
});

export const updateBlogSchema = z.object({
  title:  z.string().min(1).max(200).optional(),
  body:   z.string().min(1).max(200_000).optional(),
  status: z.enum(["DRAFT", "SCHEDULED", "PUBLISHED"]).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
});

export type CreateBlogDto = z.infer<typeof createBlogSchema>;
export type UpdateBlogDto = z.infer<typeof updateBlogSchema>;
