import { z } from "zod";

// ─── Create ────────────────────────────────────────────────────────────────────

export const createActivitySchema = z.discriminatedUnion("kind", [
  z.object({
    kind:       z.literal("TEXT"),
    body:       z.string().min(1).max(2000),
    hasSpoiler: z.boolean().optional().default(false),
    linkedAnimeId: z.string().optional(),
  }),
  z.object({
    kind:           z.literal("LIST_UPDATE"),
    linkedAnimeId:  z.string().min(1),
    verb:           z.enum([
      "WATCHED_EPISODE","COMPLETED","ADDED_TO_PLAN",
      "DROPPED","RATED","STARTED","REWATCHING",
    ]),
    episodeNumber:  z.number().int().positive().optional(),
    score:          z.number().int().min(1).max(10).optional(),
    body:           z.string().max(2000).optional(),
    hasSpoiler:     z.boolean().optional().default(false),
  }),
  z.object({
    kind:        z.literal("MESSAGE"),
    body:        z.string().min(1).max(2000),
    wallOwnerId: z.string().min(1),
    hasSpoiler:  z.boolean().optional().default(false),
  }),
]);

export type CreateActivityDto = z.infer<typeof createActivitySchema>;

// ─── Repost ────────────────────────────────────────────────────────────────────

export const repostActivitySchema = z.object({
  body: z.string().max(2000).optional(), // optional quote-repost body
});
export type RepostActivityDto = z.infer<typeof repostActivitySchema>;

// ─── Reply ─────────────────────────────────────────────────────────────────────

export const createReplySchema = z.object({
  body:          z.string().min(1).max(2000),
  parentReplyId: z.string().optional(),
  hasSpoiler:    z.boolean().optional().default(false),
});
export type CreateReplyDto = z.infer<typeof createReplySchema>;

// ─── Feed query ────────────────────────────────────────────────────────────────

export const feedQuerySchema = z.object({
  type:   z.enum(["following", "global", "profile"]).default("global"),
  userId: z.string().optional(), // for type=profile
  cursor: z.string().optional(),
  limit:  z.coerce.number().int().min(1).max(50).default(20),
});
export type FeedQueryDto = z.infer<typeof feedQuerySchema>;
