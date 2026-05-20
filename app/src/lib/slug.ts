import { prisma } from "../config/prisma";

const SLUG_MAX_LEN = 50;
const SLUG_MIN_LEN = 3;
const SLUG_REGEX   = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

/**
 * Transform any string into a URL-safe slug segment.
 * e.g. "Hemant Sharma!" → "hemant-sharma"
 */
export function generateSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")   // strip non-alphanumeric (keep spaces + hyphens)
    .replace(/[\s_]+/g, "-")         // spaces/underscores → hyphens
    .replace(/-{2,}/g, "-")          // collapse consecutive hyphens
    .replace(/^-+|-+$/g, "")         // strip leading/trailing hyphens
    .slice(0, SLUG_MAX_LEN);
}

/**
 * Validate a slug against format rules.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateSlug(slug: string): string | null {
  if (!slug || slug.length < SLUG_MIN_LEN) return `Slug must be at least ${SLUG_MIN_LEN} characters`;
  if (slug.length > SLUG_MAX_LEN)          return `Slug must be at most ${SLUG_MAX_LEN} characters`;
  if (!SLUG_REGEX.test(slug))              return "Slug must be lowercase letters, numbers, and hyphens only";
  return null;
}

/**
 * Generate a unique slug. If the base slug is taken, appends -2, -3, etc.
 * Falls back to timestamp suffix if all numeric suffixes are exhausted.
 */
export async function generateUniqueSlug(base: string, maxAttempts = 15): Promise<string> {
  const clean = generateSlug(base) || "user";

  // Try base slug first
  const exists = await prisma.user.findUnique({ where: { slug: clean }, select: { id: true } });
  if (!exists) return clean;

  // Try -2, -3, ..., -N
  for (let i = 2; i <= maxAttempts; i++) {
    const candidate = `${clean.slice(0, SLUG_MAX_LEN - String(i).length - 1)}-${i}`;
    const taken = await prisma.user.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }

  // Last resort: timestamp suffix (always unique)
  return `${clean.slice(0, 38)}-${Date.now().toString(36)}`;
}
