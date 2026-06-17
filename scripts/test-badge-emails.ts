/**
 * Send the badge congrats emails to a test address so we can eyeball them before
 * they go live. Renders the REAL templates from lib/email.ts and sends via the
 * configured SMTP (Resend in prod) — bypassing the prod-only sendEmail() gate.
 *
 * Usage:
 *   set -a; source ~/kaiveron-secrets/backend-apprunner.env; set +a
 *   npx tsx scripts/test-badge-emails.ts info@athavita.com
 */
import nodemailer from "nodemailer"
import { creatorBadgeEmail, foundingBadgeEmail, verifiedBadgeEmail, newMessageEmail } from "../app/src/lib/email"
import { unsubscribeUrl } from "../app/src/lib/unsubscribe"

async function main() {
  const to = process.argv[2] || process.env.TEST_EMAIL || "info@athavita.com"
  const name = process.argv[3] || "Priyanshu"
  const host = process.env.SMTP_HOST
  const port = Number(process.env.SMTP_PORT || 465)
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  const from = process.env.EMAIL_FROM || user

  if (!host || !user || !pass) {
    console.error("Missing SMTP_HOST / SMTP_USER / SMTP_PASS in env.")
    console.error("Run: set -a; source ~/kaiveron-secrets/backend-apprunner.env; set +a")
    process.exit(1)
  }

  const transporter = nodemailer.createTransport({
    host, port, secure: port === 465, auth: { user, pass },
  })

  const samples = [
    creatorBadgeEmail(to, name, 250),       // Verified Creator (+250 rep reward)
    foundingBadgeEmail(to, name, 7, 250),   // Founding Creator #7 / 250 (+250 rep)
    verifiedBadgeEmail(to, name, "USER"),   // Verified (user)
    verifiedBadgeEmail(to, name, "STUDIO"), // Verified Studio
    // DM digest — carries the RFC 8058 one-click unsubscribe headers (#3 check:
    // Gmail should show an "Unsubscribe" affordance next to the sender).
    newMessageEmail(to, name, [{ name: "Aki", preview: "yo did you watch the new ep??", unread: 2 }], 2, unsubscribeUrl("test-user-id", "msg")),
  ]

  for (const m of samples) {
    const info = await transporter.sendMail({
      from: `"Kaiveron" <${from}>`,
      to: m.to,
      subject: m.subject,
      html: m.html,
      ...(m.headers ? { headers: m.headers } : {}),
    })
    console.log(`✓ sent "${m.subject}" → ${to}  (${info.messageId})`)
  }
  console.log("Done. Check the inbox.")
}

main().catch((e) => { console.error(e); process.exit(1) })
