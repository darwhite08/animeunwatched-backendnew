import { z } from "zod";

const IMAGE_MIME = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export const avatarUploadSchema = z.object({
  contentType: IMAGE_MIME,
  size: z.number().int().positive().max(5 * 1024 * 1024).optional(),
});

export const postImageUploadSchema = z.object({
  contentType: IMAGE_MIME,
  size: z.number().int().positive().max(10 * 1024 * 1024).optional(),
});
