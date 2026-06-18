/**
 * One-off: send the "Community Lead" invitation email.
 *   set -a; source ~/kaiveron-secrets/backend-apprunner.env; set +a
 *   npx tsx scripts/send-community-lead.ts <to> <name> [replyTo]
 */
import nodemailer from "nodemailer"

async function main() {
  const to = process.argv[2]
  const name = process.argv[3] || "there"
  const replyTo = process.argv[4] || "chandrapriyanshu10@gmail.com"
  if (!to) { console.error("usage: send-community-lead.ts <to> <name> [replyTo]"); process.exit(1) }

  const subject = "You're now an Official Community Lead on Kaiveron 🎉"
  const paras = [
    `Hey ${name},`,
    `Quick and exciting note — I'd like to officially assign you as a Community Lead for anime &amp; manga on Kaiveron.`,
    `It means you'll be one of the people helping shape and steer the community: welcoming new members, sparking discussion, flagging what's working (and what isn't), and generally being a trusted voice as we grow.`,
    `You were an obvious pick. You clearly care about this space, and that's exactly the kind of person I want representing Kaiveron early on.`,
    `If you're in, just reply and I'll get you set up with the official badge, access, and a short rundown of what the role looks like day to day. No heavy commitment — mostly doing what you already do, with a bit more reach.`,
    `Glad to have you on board.`,
  ]
  const text = paras.join("\n\n").replace(/&amp;/g, "&") + "\n\nBest,\nKaiveron"
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#111;max-width:560px">
${paras.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join("\n")}
<p style="margin:24px 0 0">Best,<br>Kaiveron</p>
</div>`

  const port = Number(process.env.SMTP_PORT || 465)
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  })
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER
  const info = await t.sendMail({ from: `"Kaiveron" <${from}>`, to, replyTo, subject, text, html })
  console.log(`✓ sent "${subject}" → ${to} (reply-to ${replyTo})  ${info.messageId}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
