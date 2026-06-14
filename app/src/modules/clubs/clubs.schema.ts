import { z } from "zod";

export const createClubSchema = z.object({
  name:        z.string().min(3).max(60),
  slug:        z.string().min(3).max(30).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
  description: z.string().max(1000).optional(),
  category:    z.string().max(40).optional(),
  visibility:  z.enum(["PUBLIC", "PRIVATE"]).optional(),
  bannerUrl:   z.string().url().max(500).nullable().optional(),
  avatarUrl:   z.string().url().max(500).nullable().optional(),
});

export const updateClubSchema = createClubSchema.partial().extend({
  rules:          z.string().max(5000).optional(),
  welcomeMessage: z.string().max(2000).optional(),
  bannerUrl:      z.string().url().max(500).nullable().optional(),
  avatarUrl:      z.string().url().max(500).nullable().optional(),
});

export const createInviteSchema = z.object({
  expiresInDays: z.number().int().min(1).max(90).nullable().optional(),
  maxUses:       z.number().int().min(1).max(1000).nullable().optional(),
});

export type CreateClubDto = z.infer<typeof createClubSchema>;
export type UpdateClubDto = z.infer<typeof updateClubSchema>;
export type CreateInviteDto = z.infer<typeof createInviteSchema>;
