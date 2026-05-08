import { z } from "zod";

export const browseQuerySchema = z.object({
  q: z.string().optional(),
  year: z.coerce.number().int().optional(),
  season: z.enum(["winter", "spring", "summer", "fall"]).optional(),
  genre: z.string().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type BrowseQuery = z.infer<typeof browseQuerySchema>;
