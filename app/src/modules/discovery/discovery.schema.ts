import { z } from "zod";

export const aiPromptSchema = z.object({
  prompt: z.string().trim().min(3).max(500),
  limit:  z.number().int().min(1).max(24).optional().default(12),
});
export type AiPromptDto = z.infer<typeof aiPromptSchema>;

export const moodSchema = z.object({
  mood:   z.enum([
    "uplifting", "melancholic", "intense", "cozy", "thrilling",
    "romantic", "thought-provoking", "epic", "lighthearted", "dark",
  ]),
  energy: z.enum(["low", "medium", "high"]).optional(),
  depth:  z.enum(["light", "deep"]).optional(),
  limit:  z.number().int().min(1).max(24).optional().default(12),
});
export type MoodDto = z.infer<typeof moodSchema>;

export const quizSchema = z.object({
  answers: z.object({
    favoriteGenre:   z.string().min(1).max(50).optional(),
    preferredLength: z.enum(["movie", "short", "medium", "long"]).optional(),
    tone:            z.enum(["serious", "funny", "mixed"]).optional(),
    era:             z.enum(["classic", "modern", "any"]).optional(),
    pacing:          z.enum(["slow-burn", "fast-paced", "balanced"]).optional(),
  }),
  limit: z.number().int().min(1).max(24).optional().default(12),
});
export type QuizDto = z.infer<typeof quizSchema>;
