import { z } from "zod";

export const MANGA_STATUS = ["READING", "COMPLETED", "PLAN_TO_READ", "ON_HOLD", "DROPPED"] as const;
const statusEnum = z.enum(MANGA_STATUS);

export const addMangaSchema = z.object({
  anilistId: z.number().int().positive(),
  title: z.string().min(1).max(300),
  coverUrl: z.string().url().max(600).nullish(),
  author: z.string().max(200).nullish(),
  format: z.string().max(40).nullish(),
  totalChapters: z.number().int().nonnegative().nullish(),
  genre: z.string().max(80).nullish(),
  status: statusEnum.optional(),
});

export const updateMangaSchema = z.object({
  status: statusEnum.optional(),
  progress: z.number().int().min(0).max(100000).optional(),
  score: z.number().int().min(0).max(10).nullish(),
});

export type AddMangaDto = z.infer<typeof addMangaSchema>;
export type UpdateMangaDto = z.infer<typeof updateMangaSchema>;
