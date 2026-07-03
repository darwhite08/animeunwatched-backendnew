/**
 * Waitlist "you're off the line — the door's open" invitation email.
 *
 * Send a TEST to one address first:
 *   set -a; source ~/kaiveron-secrets/backend-apprunner.env; set +a
 *   npx tsx scripts/send-waitlist-invite.ts --to chandrapriyanshu10@gmail.com
 *
 * Optional: set the CTA invite code (so /register opens the signup form under
 * invite-only mode):
 *   npx tsx scripts/send-waitlist-invite.ts --to <addr> --invite KVRN-XXXX-XXXX
 *
 * Real cohort send is wired separately (reads the Waitlist via the admin API),
 * NOT in this script — this one only sends to the addresses passed via --to.
 */
import nodemailer from "nodemailer"
import { buildWaitlistInvite } from "../app/src/lib/waitlistInviteEmail"

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

// Shared with the cohort-send endpoint so preview == real send, byte for byte.
const buildEmail = (invite?: string) => buildWaitlistInvite(invite)

async function main() {
  const tos = (arg("to") ?? "chandrapriyanshu10@gmail.com").split(",").map(s => s.trim()).filter(Boolean)
  const invite = arg("invite")
  const replyTo = arg("replyTo") ?? "chandrapriyanshu10@gmail.com"
  const { subject, text, html } = buildEmail(invite)

  const port = Number(process.env.SMTP_PORT || 465)
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  })
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER

  for (const to of tos) {
    const info = await t.sendMail({ from: `"Kaiveron" <${from}>`, to, replyTo, subject, text, html })
    console.log(`✓ sent "${subject}" → ${to}  ${info.messageId}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
