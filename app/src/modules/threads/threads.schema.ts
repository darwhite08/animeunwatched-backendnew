import { z } from "zod";

export const createThreadSchema = z.object({
  title:   z.string().min(3).max(120),
  content: z.string().min(10).max(20000),
});

export const updateThreadSchema = createThreadSchema.partial();

export const createReplySchema = z.object({
  content:  z.string().min(1).max(10000),
  parentId: z.string().cuid().optional(),
});

export type CreateThreadDto = z.infer<typeof createThreadSchema>;
export type UpdateThreadDto = z.infer<typeof updateThreadSchema>;
export type CreateReplyDto  = z.infer<typeof createReplySchema>;
