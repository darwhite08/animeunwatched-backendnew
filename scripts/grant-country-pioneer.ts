/**
 * One-off: grant the "First from <country>" badge + send a personalized email.
 *   set -a; source ~/kaiveron-secrets/backend-apprunner.env; set +a
 *   npx tsx scripts/grant-country-pioneer.ts <email> <code> <CountryName> [firstName]
 */
import nodemailer from "nodemailer"
import { prisma } from "../app/src/config/prisma"

async function main() {
  const email = process.argv[2]
  const code = process.argv[3]            // e.g. FIRST_FROM_RO
  const country = process.argv[4]         // e.g. Romania
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, displayName: true } })
  if (!user) { console.error("user not found:", email); process.exit(1) }
  const name = process.argv[5] || (user.displayName || "there").split(/\s+/)[0]

  // 1) Grant the badge (idempotent on (userId, code)).
  await prisma.userBadge.upsert({
    where: { userId_code: { userId: user.id, code } },
    create: { userId: user.id, code },
    update: {},
  })
  console.log(`✓ badge ${code} granted to ${email}`)

  // 2) Send the personalized email.
  const subject = `You're Kaiveron's first member from ${country} 🎉`
  const paras = [
    `Hey ${name},`,
    `A little milestone worth celebrating: you're the <strong>very first person from ${country}</strong> to join Kaiveron.`,
    `That makes you a genuine pioneer here — before anyone else in your country, you found this place and decided to be part of it. So I wanted to reach out personally and say thank you. I've added a <strong>"First from ${country}"</strong> badge to your account to mark it.`,
    `We're just getting started, and early members like you set the tone for everyone who comes after. If there's anything you'd love to see on Kaiveron, just reply — I read everything.`,
    `Welcome, and thanks for being first.`,
  ]
  const text = paras.join("\n\n").replace(/<[^>]+>/g, "") + "\n\nBest,\nKaiveron"
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#111;max-width:560px">
${paras.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join("\n")}
<p style="margin:24px 0 0">Best,<br>Kaiveron</p></div>`

  const port = Number(process.env.SMTP_PORT || 465)
  const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } })
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER
  const info = await t.sendMail({ from: `"Kaiveron" <${from}>`, to: email, replyTo: "chandrapriyanshu10@gmail.com", subject, text, html })
  console.log(`✓ sent "${subject}" → ${email}  ${info.messageId}`)
  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
