import { z } from "zod";

export const browseMangaQuerySchema = z.object({
  q: z.string().optional(),
  /// Manga | Novel | Light Novel | One-shot | Doujinshi | Manhwa | Manhua
  type: z.string().optional(),
  /// Publishing | Finished | On Hiatus | Discontinued
  status: z.string().optional(),
  /// Shounen | Shoujo | Seinen | Josei | Kids
  demographic: z.string().optional(),
  /// Any Genre.name — includes Boys Love / Girls Love
  genre: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type BrowseMangaQuery = z.infer<typeof browseMangaQuerySchema>;
