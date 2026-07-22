import { z } from "zod";

export const browseQuerySchema = z.object({
  q: z.string().optional(),
  year: z.coerce.number().int().optional(),
  season: z.enum(["winter", "spring", "summer", "fall"]).optional(),
  genre: z.string().optional(),
  studio: z.string().optional(),
  type: z.string().optional(),
  // Accepts either the raw MAL status ("Currently Airing") or the UI keyword
  // ("airing" | "finished" | "upcoming"); the service normalizes keywords.
  status: z.string().optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // ── Vault filters (server-side so pagination stays accurate) ──
  min_score: z.coerce.number().min(0).max(10).optional(),
  year_from: z.coerce.number().int().optional(),
  year_to: z.coerce.number().int().optional(),
  eps: z.enum(["short", "medium", "long", "movie"]).optional(),
  /** "true" → exclude anime already on the requesting user's list (auth only). */
  exclude_listed: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type BrowseQuery = z.infer<typeof browseQuerySchema>;
