import { z } from "zod";

export const createPollSchema = z.object({
  question:     z.string().min(5).max(200),
  options:      z.array(z.string().min(1).max(100)).min(2).max(6),
  // expiresInDays defaults to 7 if neither is provided
  expiresInDays: z.number().min(1).max(30).optional(),
  expiresIn:     z.number().min(1).max(720).optional(), // in hours
});

export const voteSchema = z.object({
  optionId: z.string().min(1),
});

export type CreatePollDto = z.infer<typeof createPollSchema>;
export type VoteDto = z.infer<typeof voteSchema>;
