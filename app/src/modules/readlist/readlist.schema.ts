import { z } from "zod";

export const MANGA_STATUS = ["READING", "COMPLETED", "PLAN_TO_READ", "ON_HOLD", "DROPPED"] as const;
const statusEnum = z.enum(MANGA_STATUS);

// Two add paths:
//  - catalog (preferred): { mangaId } — metadata comes from the local Manga row
//  - legacy AniList:      { anilistId, title, ... } — kept so the current web
//    add-modal keeps working until the clients switch to /manga/search
export const addMangaSchema = z
  .object({
    mangaId: z.string().min(1).optional(),
    anilistId: z.number().int().positive().optional(),
    title: z.string().min(1).max(300).optional(),
    coverUrl: z.string().url().max(600).nullish(),
    author: z.string().max(200).nullish(),
    format: z.string().max(40).nullish(),
    totalChapters: z.number().int().nonnegative().nullish(),
    genre: z.string().max(80).nullish(),
    status: statusEnum.optional(),
  })
  .refine((v) => !!v.mangaId || (!!v.anilistId && !!v.title), {
    message: "Provide mangaId (catalog) or anilistId + title (legacy)",
  });

export const updateMangaSchema = z.object({
  status: statusEnum.optional(),
  progress: z.number().int().min(0).max(100000).optional(),
  volumesRead: z.number().int().min(0).max(10000).optional(),
  score: z.number().int().min(0).max(10).nullish(),
});

export type AddMangaDto = z.infer<typeof addMangaSchema>;
export type UpdateMangaDto = z.infer<typeof updateMangaSchema>;
