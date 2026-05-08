import { z } from "zod";

export const upsertEntrySchema = z.object({
  status: z.enum(["PLAN_TO_WATCH", "WATCHING", "COMPLETED", "ON_HOLD", "DROPPED"]),
  score: z.number().min(1).max(10).optional(),
  episodesSeen: z.number().int().min(0).optional(),
  startedAt: z.string().datetime().optional().transform((v) => (v ? new Date(v) : undefined)),
  finishedAt: z.string().datetime().optional().transform((v) => (v ? new Date(v) : undefined)),
  notes: z.string().max(2000).optional(),
});

export type UpsertEntryDto = z.infer<typeof upsertEntrySchema>;
