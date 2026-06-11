import { z } from "zod";

export const blogCategoryEnum = z.enum([
  "DEEP_DIVE",
  "REVIEW",
  "FEATURE",
  "DISCUSSION",
  "THEORY",
  "OPINION",
  "LIST",
  "NEWS",
]);

export const createBlogSchema = z.object({
  title:  z.string().min(1).max(200),
  body:   z.string().min(1).max(200_000),
  status: z.enum(["DRAFT", "SCHEDULED", "PUBLISHED"]).optional(),
  scheduledAt: z.string().datetime().optional(),
  category:    blogCategoryEnum.nullable().optional(),
  hasSpoilers: z.boolean().optional(),
  animeMalId:  z.number().int().positive().nullable().optional(),
  animeTitle:  z.string().max(300).nullable().optional(),
});

export const updateBlogSchema = z.object({
  title:  z.string().min(1).max(200).optional(),
  body:   z.string().min(1).max(200_000).optional(),
  status: z.enum(["DRAFT", "SCHEDULED", "PUBLISHED"]).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  category:    blogCategoryEnum.nullable().optional(),
  hasSpoilers: z.boolean().optional(),
  animeMalId:  z.number().int().positive().nullable().optional(),
  animeTitle:  z.string().max(300).nullable().optional(),
});

export type BlogCategory = z.infer<typeof blogCategoryEnum>;
export type CreateBlogDto = z.infer<typeof createBlogSchema>;
export type UpdateBlogDto = z.infer<typeof updateBlogSchema>;
