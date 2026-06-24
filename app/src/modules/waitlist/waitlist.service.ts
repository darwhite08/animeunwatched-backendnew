import { prisma } from "../../config/prisma";
import type { JoinWaitlistInput } from "./waitlist.schema";

/**
 * Idempotent join — one row per email. Re-submitting the same email is a no-op
 * success (never leaks whether the email was already on the list).
 *
 * If the email already belongs to a registered member, we DON'T waitlist them —
 * `alreadyMember: true` is returned so the client can point them at sign-in
 * instead of telling an existing user they're "on the list".
 */
export async function joinWaitlist(
  input: JoinWaitlistInput,
): Promise<{ ok: true; alreadyOn: boolean; alreadyMember: boolean }> {
  // Already a registered member? Don't add them to the waitlist. Case-insensitive
  // match: User.email may be stored with original casing (register doesn't
  // lowercase it), while the waitlist email is normalized to lowercase.
  const member = await prisma.user.findFirst({
    where: { email: { equals: input.email, mode: "insensitive" } },
    select: { id: true },
  });
  if (member) return { ok: true, alreadyOn: false, alreadyMember: true };

  const existing = await prisma.waitlist.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) return { ok: true, alreadyOn: true, alreadyMember: false };

  await prisma.waitlist.create({
    data: {
      email:      input.email,
      source:     input.source ?? "register",
      referredBy: input.referredBy ?? null,
    },
  });
  return { ok: true, alreadyOn: false, alreadyMember: false };
}

/** Admin: paginated list, newest first. */
export async function listWaitlist(opts: { take?: number; skip?: number } = {}) {
  const take = Math.min(Math.max(opts.take ?? 100, 1), 500);
  const skip = Math.max(opts.skip ?? 0, 0);
  const [total, entries] = await Promise.all([
    prisma.waitlist.count(),
    prisma.waitlist.findMany({
      orderBy: { createdAt: "desc" },
      take,
      skip,
      select: { id: true, email: true, source: true, referredBy: true, invited: true, createdAt: true },
    }),
  ]);
  return { total, entries };
}
