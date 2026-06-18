/**
 * State-ambassador outreach (honest-persuasion version).
 *   set -a; source ~/kaiveron-secrets/backend-apprunner.env; set +a
 *   npx tsx scripts/send-state-ambassador.ts <to> <firstName> <State>
 */
import nodemailer from "nodemailer"

async function main() {
  const to = process.argv[2]
  const name = process.argv[3] || "there"
  const state = process.argv[4] || "your state"
  if (!to) { console.error("usage: <to> <firstName> <State>"); process.exit(1) }

  const subject = `You're Kaiveron's first member from ${state}`
  const paras = [
    `Hey ${name},`,
    `Quick note — out of everyone in ${state}, you joined Kaiveron first. Genuinely #1 in your state, which makes you a founding member here.`,
    `I'm building Kaiveron with the people who showed up early, and in ${state} that's you. So I wanted to ask you directly: would you help shape the community there?`,
    `Nothing heavy. This week, if you're up for it, just do one thing — post about an anime you love, or start a club for your favourite series and invite a couple of friends. That alone gets it going.`,
    `Do that and you're ${state}'s founding voice on Kaiveron — you'll get a "First from ${state}" badge on your profile, and a direct line to me for anything you'd want changed.`,
    `If you're in, just reply to this email. Glad you found us first.`,
  ]
  const text = paras.join("\n\n").replace(/<br>/g, "\n").replace(/<[^>]+>/g, "") + "\n\n— Kaiveron"
  const ACCENT = "#f59e0b"
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:20px;overflow:hidden;border:1px solid #1a1a1a">
    <div style="background:linear-gradient(135deg,#0f0f0f,#1a1100);padding:30px 40px;border-bottom:1px solid #1a1a1a">
      <span style="font-size:22px;font-weight:900;font-style:italic;letter-spacing:-0.05em;color:${ACCENT}">Kaiveron</span>
    </div>
    <div style="padding:40px">
      <p style="color:${ACCENT};font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.2em;margin:0 0 12px">Founding member · ${state}</p>
      <h1 style="color:#fff;font-size:27px;font-weight:900;margin:0 0 18px;font-style:italic;letter-spacing:-0.02em;line-height:1.15">You got to ${state} first, ${name}.</h1>
      <p style="color:#aaa;line-height:1.7;margin:0 0 18px">Out of everyone in ${state}, you joined Kaiveron first — genuinely #1 in your state. That makes you a <strong style="color:#fff">founding member</strong> here.</p>
      <p style="color:#aaa;line-height:1.7;margin:0 0 22px">I'm building Kaiveron with the people who showed up early, and in ${state} that's you. Would you help shape the community there?</p>

      <div style="background:#0f0f0f;border:1px solid #1f1a08;border-radius:16px;padding:20px 22px;margin:0 0 22px">
        <p style="color:${ACCENT};font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.15em;margin:0 0 12px">Your move this week — pick one (5 min)</p>
        <p style="color:#ddd;font-size:14px;line-height:1.7;margin:0">▸ Post about an anime you'd defend with your life<br>▸ Or start a club for your favourite series &amp; invite 2 friends</p>
      </div>

      <p style="color:#aaa;line-height:1.7;margin:0 0 24px">Do that and you're <strong style="color:#fff">${state}'s founding voice</strong> on Kaiveron — you'll carry a <strong style="color:${ACCENT}">"First from ${state}"</strong> badge on your profile, and a direct line to me for anything you'd want changed.</p>

      <a href="https://kaiveron.com" style="display:inline-block;padding:15px 32px;background:linear-gradient(135deg,#fbbf24,${ACCENT});color:#000;text-decoration:none;border-radius:12px;font-weight:900;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;box-shadow:0 8px 24px rgba(245,158,11,0.25)">Open Kaiveron →</a>

      <p style="color:#666;font-size:13px;line-height:1.6;margin:28px 0 0">If you're in, just reply to this email. Glad you found us first. 🧡<br><span style="color:#444">— Kaiveron</span></p>
    </div>
    <div style="padding:22px 40px;background:#050505;border-top:1px solid #1a1a1a">
      <p style="color:#444;font-size:11px;margin:0">You're getting this because you're an early ${state} member of Kaiveron.</p>
    </div>
  </div>`

  const port = Number(process.env.SMTP_PORT || 465)
  const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } })
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER
  const info = await t.sendMail({ from: `"Kaiveron" <${from}>`, to, replyTo: "chandrapriyanshu10@gmail.com", subject, text, html })
  console.log(`✓ sent "${subject}" → ${to}  ${info.messageId}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
