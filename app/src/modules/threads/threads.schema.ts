import { z } from "zod";

export const createThreadSchema = z.object({
  title:    z.string().min(3).max(120),
  content:  z.string().min(10).max(20000),
  imageUrl: z.string().url().max(500).nullable().optional(),
  kind:     z.enum(["DISCUSSION", "ANNOUNCEMENT", "CHALLENGE", "EPISODE"]).optional(),
  tags:     z.array(z.string().max(24)).max(5).optional(),
});

export const updateThreadSchema = createThreadSchema.partial();

export const createReplySchema = z.object({
  content:  z.string().min(1).max(10000),
  imageUrl: z.string().url().max(500).nullable().optional(),
  parentId: z.string().cuid().optional(),
});

export type CreateThreadDto = z.infer<typeof createThreadSchema>;
export type UpdateThreadDto = z.infer<typeof updateThreadSchema>;
export type CreateReplyDto  = z.infer<typeof createReplySchema>;
