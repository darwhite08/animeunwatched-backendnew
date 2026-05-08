import { z } from "zod";

export const updateMeSchema = z.object({
  displayName: z.string().min(1).max(60).optional(),
  bio: z.string().max(500).optional(),
  avatarUrl: z.string().url().optional(),
});

export type UpdateMeDto = z.infer<typeof updateMeSchema>;
