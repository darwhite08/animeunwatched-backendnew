import { prisma } from "../config/prisma";
import { Prisma } from "../generated/prisma/client";

/**
 * Founding Creator badge — granted to the first N users to become a Verified
 * Creator (verifiedKind = "CREATOR"), first-come. Issuance is permanently
 * closed once the cap is reached; the (cap+1)th verified creator gets nothing.
 *
 * Correctness under concurrency is the whole point: two simultaneous grants must
 * never both read issued = cap-1 and both succeed. We serialize on a single
 * counter row via `SELECT ... FOR UPDATE` inside one transaction — the second
 * caller blocks on the row lock until the first commits, so the count is exact.
 *
 * The badge is stored in the generic UserBadge table (code "FOUNDING_CREATOR",
 * serial = the 1-based ordinal). Idempotent: calling twice for the same user
 * returns the existing badge and never double-increments.
 */

export const FOUNDING_CODE = "FOUNDING_CREATOR";

export interface FoundingBadge {
  id: string;
  userId: string;
  code: string;
  serial: number | null;
  earnedAt: Date;
}

/** Ensure the singleton counter row exists (idempotent). */
export async function ensureFoundingCounter(): Promise<void> {
  await prisma.foundingCounter.upsert({
    where: { id: 1 },
    create: { id: 1, issued: 0, cap: 250 },
    update: {},
  });
}

async function grantOnce(userId: string): Promise<FoundingBadge | null> {
  return prisma.$transaction(async (tx) => {
    // Lock the counter row FOR UPDATE — this is the serialization point. Any
    // concurrent grant blocks here until we commit, so no two readers can both
    // observe the same `issued` and both proceed.
    const rows = await tx.$queryRaw<Array<{ issued: number; cap: number }>>`
      SELECT issued, cap FROM "FoundingCounter" WHERE id = 1 FOR UPDATE`;
    const counter = rows[0];
    if (!counter) return null; // ensureFoundingCounter() guarantees this won't happen

    // Idempotency: a user who already holds Founding keeps their badge and
    // serial, regardless of whether the window has since closed. No increment.
    const existing = await tx.userBadge.findUnique({
      where: { userId_code: { userId, code: FOUNDING_CODE } },
    });
    if (existing) return existing as FoundingBadge;

    // Window closed → issue nothing.
    if (counter.issued >= counter.cap) return null;

    const serial = counter.issued + 1;
    await tx.$executeRaw`UPDATE "FoundingCounter" SET issued = ${serial} WHERE id = 1`;
    const badge = await tx.userBadge.create({
      data: { userId, code: FOUNDING_CODE, serial },
    });
    return badge as FoundingBadge;
  });
}

/**
 * Grant the Founding Creator badge to `userId`, or return null if the window is
 * closed. Idempotent and concurrency-safe. Retries the transaction a few times
 * on transient serialization/deadlock errors, then fails closed (returns null —
 * never over-grants).
 */
export async function grantFoundingCreatorBadge(userId: string): Promise<FoundingBadge | null> {
  await ensureFoundingCounter(); // guarantee the counter row exists before we lock it
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await grantOnce(userId);
    } catch (err) {
      // A concurrent grant for the SAME user can lose the create race → unique
      // violation on (userId, code). That's success-by-another-path: return the
      // badge they now hold.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const existing = await prisma.userBadge.findUnique({
          where: { userId_code: { userId, code: FOUNDING_CODE } },
        });
        if (existing) return existing as FoundingBadge;
      }
      // Transient serialization failure / deadlock / lock timeout → brief backoff + retry.
      const transient =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        (err.code === "P2034" || err.code === "P2024");
      if (!transient || attempt === 2) {
        if (attempt === 2) return null; // exhausted retries — fail closed, never over-grant
        // Non-transient, non-P2002 error on a non-final attempt: rethrow so callers log it.
        if (!transient) throw err;
      }
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
  return null;
}
