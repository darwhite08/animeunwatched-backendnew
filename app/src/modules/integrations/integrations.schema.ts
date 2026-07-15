import { z } from "zod";
import { blogCategoryEnum } from "../blogs/blogs.schema";

// ─── Key management (creator, session-authed) ───────────────────────────────

export const createKeySchema = z.object({
  label: z.string().trim().min(1).max(80),
});

// ─── Inbound draft intake (external service, key-authed) ────────────────────
//
// External services send the human "chip" label OR the internal enum value —
// normalize "Deep Dive" / "deep dive" / "DEEP_DIVE" → DEEP_DIVE before validating.
const categoryInput = z
  .string()
  .transform((s) => s.trim().toUpperCase().replace(/[\s-]+/g, "_"))
  .pipe(blogCategoryEnum)
  .nullish();

// sources may be plain URLs or { url, label? } objects. Normalized to a list of
// { url, label } and appended to the body as a "Sources" section so they render
// in the existing editor with no new UI.
const sourceItem = z.union([
  z.string().url(),
  z.object({ url: z.string().url(), label: z.string().trim().max(200).optional() }),
]);

export const submitDraftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(200_000),
  category: categoryInput,
  // Inbound flag is the inverse of the stored hasSpoilers. Default: no spoilers.
  noSpoilers: z.boolean().optional(),
  animeMalId: z.number().int().positive().nullish(),
  sources: z.array(sourceItem).max(50).optional(),
});

export type CreateKeyDto = z.infer<typeof createKeySchema>;
export type SubmitDraftDto = z.infer<typeof submitDraftSchema>;
export type NormalizedSource = { url: string; label?: string };
