import { z } from "zod";

export const createShotSchema = z.object({
  videoUrl: z.string().url().max(500),
  thumbnailUrl: z.string().url().max(500).optional(),
  caption: z.string().max(2200).optional(),
  durationMs: z.number().int().positive().max(5 * 60 * 1000).optional(),
  animeId: z.string().optional(),
});

export type CreateShotDto = z.infer<typeof createShotSchema>;

export const recordViewSchema = z.object({
  // First-party random id from the client (localStorage). Bounded length so a
  // crafted body can't bloat the ledger row.
  viewerKey: z.string().min(8).max(64),
  watchedMs: z.number().int().nonnegative().max(10 * 60 * 1000).optional(),
});

export type RecordViewDto = z.infer<typeof recordViewSchema>;

export const recordFeedbackSchema = z.object({
  viewerKey: z.string().min(8).max(64),
  kind: z.enum(["SKIP", "NOT_INTERESTED"]),
  watchedMs: z.number().int().nonnegative().max(10 * 60 * 1000).optional(),
});

export type RecordFeedbackDto = z.infer<typeof recordFeedbackSchema>;
