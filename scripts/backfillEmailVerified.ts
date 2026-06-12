/**
 * One-time backfill: grandfather every PRE-EXISTING user as email-verified.
 *
 * The emailVerifiedAt column is added nullable, so all existing rows start NULL.
 * Email-verification enforcement is inert while SMTP is unconfigured — but the
 * moment SMTP is turned on, any NULL row would be blocked from posting. This
 * backfill sets emailVerifiedAt = createdAt for every legacy user so only
 * genuinely-new email signups (created AFTER SMTP is enabled) are ever unverified.
 *
 * Safe to run now: with SMTP off, register() already stamps new users verified,
 * so there are no "intentionally unverified" rows to accidentally confirm.
 *
 * Run: npx tsx scripts/backfillEmailVerified.ts
 */
import "dotenv/config";
import { PrismaClient } from "../app/src/generated/prisma/client";

const prisma = new PrismaClient();

async function main() {
  const pending = await prisma.user.count({ where: { emailVerifiedAt: null } });
  console.log(`Found ${pending} user(s) with no verification timestamp — grandfathering…`);

  // Set emailVerifiedAt = createdAt for everyone still null, in one statement.
  const result = await prisma.$executeRaw`
    UPDATE "User"
    SET "emailVerifiedAt" = "createdAt"
    WHERE "emailVerifiedAt" IS NULL`;

  console.log(`✓ Marked ${result} existing user(s) as verified.`);

  const remaining = await prisma.user.count({ where: { emailVerifiedAt: null } });
  console.log(`Remaining unverified: ${remaining} (should be 0).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
