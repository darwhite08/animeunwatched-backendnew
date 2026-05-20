/**
 * One-time backfill: generate unique slugs for all existing users who have slug = null.
 * Run: npx tsx scripts/backfill-slugs.ts
 */
import "dotenv/config";
import { PrismaClient } from "../app/src/generated/prisma/client";
import { generateUniqueSlug } from "../app/src/lib/slug";

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    where: { slug: null },
    select: { id: true, displayName: true, username: true },
  });

  console.log(`Backfilling slugs for ${users.length} user(s)…`);

  for (const user of users) {
    const base = user.displayName || user.username;
    const slug = await generateUniqueSlug(base);
    await prisma.user.update({ where: { id: user.id }, data: { slug } });
    console.log(`  ✓ ${user.username} → ${slug}`);
  }

  console.log("Done.");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
