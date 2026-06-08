import { z } from "zod";

export const updateMeSchema = z.object({
  displayName: z.string().min(1).max(60).optional(),
  bio: z.string().max(500).optional(),
  avatarUrl: z.string().url().optional(),
  isPrivate: z.boolean().optional(),
});

export type UpdateMeDto = z.infer<typeof updateMeSchema>;

export const changeUsernameSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters")
    .regex(/^[a-zA-Z0-9_]+$/, "Letters, numbers and underscores only"),
});

export type ChangeUsernameDto = z.infer<typeof changeUsernameSchema>;

export const updateSlugSchema = z.object({
  slug: z
    .string()
    .min(3, "Slug must be at least 3 characters")
    .max(50, "Slug must be at most 50 characters")
    .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, "Slug must be lowercase letters, numbers, and hyphens only"),
});

export type UpdateSlugDto = z.infer<typeof updateSlugSchema>;
