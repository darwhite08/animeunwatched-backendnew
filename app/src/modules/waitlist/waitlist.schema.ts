import { z } from "zod";

export const joinWaitlistSchema = z.object({
  email:      z.string().trim().toLowerCase().email().max(254),
  source:     z.string().trim().max(40).optional(),
  referredBy: z.string().trim().toLowerCase().max(40).optional(),
});

export type JoinWaitlistInput = z.infer<typeof joinWaitlistSchema>;
