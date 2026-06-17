/**
 * One-off: send the Founding Creator congrats email to existing founders who were
 * granted the badge BEFORE the email feature existed. Pulls each founder's email,
 * display name and serial from the DB and sends the correct "#N / 250" email.
 *
 * Skips the `kaiveron` system account and synthetic/test domains. Idempotent in
 * spirit only — re-running WILL re-send, so run once.
 *
 * Usage:
 *   set -a; source ~/kaiveron-secrets/backend-apprunner.env; set +a
 *   npx tsx scripts/send-founding-retroactive.ts          # dry-run (lists who)
 *   npx tsx scripts/send-founding-retroactive.ts --send   # actually send
 */
import nodemailer from "nodemailer"
import { prisma } from "../app/src/config/prisma"
import { foundingBadgeEmail } from "../app/src/lib/email"

const SKIP_USERNAMES = new Set(["kaiveron"])
const SYNTHETIC = ["@t.kaiveron.com", "@test.kaiveron.com", "@kaiveron.com", "@example.com", "preparmy.com"]

async function main() {
  const send = process.argv.includes("--send")
  const founders = await prisma.userBadge.findMany({
    where: { code: "FOUNDING_CREATOR" },
    orderBy: { serial: "asc" },
    select: { serial: true, user: { select: { username: true, email: true, displayName: true } } },
  })

  const targets = founders.filter((f) => {
    const u = f.user
    if (!u?.email || f.serial == null) return false
    if (SKIP_USERNAMES.has(u.username)) return false
    if (SYNTHETIC.some((d) => u.email.includes(d))) return false
    return true
  })

  console.log(`${founders.length} founders total; ${targets.length} eligible to email${send ? "" : "  (DRY RUN — pass --send to actually send)"}:`)
  for (const f of targets) console.log(`  #${f.serial}  ${f.user!.username}  <${f.user!.email}>`)

  if (!send) { await prisma.$disconnect(); return }

  const port = Number(process.env.SMTP_PORT || 465)
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  })
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER

  for (const f of targets) {
    const u = f.user!
    const m = foundingBadgeEmail(u.email, u.displayName, f.serial!)
    const info = await transporter.sendMail({ from: `"Kaiveron" <${from}>`, to: u.email, subject: m.subject, html: m.html })
    console.log(`✓ #${f.serial} → ${u.email}  (${info.messageId})`)
    await new Promise((r) => setTimeout(r, 800)) // gentle pacing
  }
  await prisma.$disconnect()
  console.log("Done.")
}

main().catch((e) => { console.error(e); process.exit(1) })
