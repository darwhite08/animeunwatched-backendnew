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

const AUDIO_MIME = z.enum([
  "audio/m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/aac",
  "audio/webm",
  "audio/ogg",
]);

export const voiceUploadSchema = z.object({
  contentType: AUDIO_MIME,
  durationMs: z.number().int().positive().max(5 * 60 * 1000).optional(),
});
