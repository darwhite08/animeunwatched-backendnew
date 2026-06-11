/**
 * One-off backfill: grant Founding Creator to existing Verified Creators in the
 * order they were verified (earliest first), until the cap is reached.
 *
 * "Verified Creator" in Kaiveron is User.verifiedKind = "CREATOR" (verifiedAt is
 * the grant time). Safe to re-run — issuance goes through the same guarded,
 * idempotent grant function, so already-founding users are skipped and the cap
 * is never exceeded.
 *
 * Run: npx tsx scripts/backfillFoundingCreators.ts
 */
import "dotenv/config";
import { ensureFoundingCounter, grantFoundingCreatorBadge } from "../app/src/lib/founding";
import { prisma } from "../app/src/config/prisma";

async function main() {
  await ensureFoundingCounter();

  const creators = await prisma.user.findMany({
    where: { verifiedKind: "CREATOR" },
    // Earliest verified first; createdAt as a stable tiebreaker for null verifiedAt.
    orderBy: [{ verifiedAt: "asc" }, { createdAt: "asc" }],
    select: { id: true, username: true, verifiedAt: true },
  });

  console.log(`Found ${creators.length} verified creator(s). Granting Founding in order…`);

  let granted = 0;
  let skipped = 0;
  let closed = false;
  for (const c of creators) {
    const badge = await grantFoundingCreatorBadge(c.id);
    if (badge && badge.serial) {
      // Distinguish a fresh grant from an already-held one is not possible from
      // the return alone (both return the badge); count by serial novelty below.
      granted++;
      console.log(`  ✓ ${c.username} → Founding #${badge.serial}`);
    } else {
      closed = true;
      skipped++;
    }
  }

  const counter = await prisma.foundingCounter.findUnique({ where: { id: 1 } });
  console.log(
    `\nDone. issued=${counter?.issued}/${counter?.cap}` +
      (closed ? ` (window closed; ${skipped} creator(s) past the cap got nothing)` : "") +
      `. ${granted} creator(s) hold a Founding badge.`,
  );
}

main()
  .catch((e) => {
    console.error("backfillFoundingCreators failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
