import { z } from "zod";

export const askSchema = z.object({
  prompt: z.string().min(1).max(2000),
  context: z
    .object({
      animeId: z.string().optional(),
      conversationId: z.string().optional(),
    })
    .optional(),
});

// AI writing assistant for the Creator Studio blog editor.
export const writeSchema = z.object({
  action: z.enum(["draft", "continue", "improve", "fix", "shorten", "expand", "titles"]),
  prompt: z.string().max(2000).optional().default(""),
  context: z.string().max(12000).optional().default(""),
});

export type WriteDto = z.infer<typeof writeSchema>;

// Public auto-translate (readers translating blogs/captions).
export const translateSchema = z.object({
  text: z.string().min(1).max(40_000),
  targetLang: z.string().min(2).max(8),
  html: z.boolean().optional(),
});

export type TranslateDto = z.infer<typeof translateSchema>;
