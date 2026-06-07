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

const VIDEO_MIME = z.enum([
  "video/mp4",
  "video/webm",
  "video/quicktime", // .mov from phone cameras
  "video/3gpp",      // older Android camera default
]);

export const shotVideoUploadSchema = z.object({
  contentType: VIDEO_MIME,
  size: z.number().int().positive().max(100 * 1024 * 1024).optional(),
});

const STORY_MIME = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/3gpp",
]);

export const storyUploadSchema = z.object({
  contentType: STORY_MIME,
  size: z.number().int().positive().max(50 * 1024 * 1024).optional(),
});
