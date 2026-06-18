/**
 * Send the premium "first member from <state>" ambassador email + grant each a
 * "First from <state>" badge, to the FIRST signup per Indian state.
 *   set -a; source ~/kaiveron-secrets/backend-apprunner.env; set +a
 *   npx tsx scripts/send-state-ambassadors-all.ts          # dry run
 *   npx tsx scripts/send-state-ambassadors-all.ts --send    # send + grant
 */
import nodemailer from "nodemailer"
import { prisma } from "../app/src/config/prisma"

const ACCENT = "#f59e0b"
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const cleanState = (r: string) => r === "National Capital Territory of Delhi" ? "Delhi" : r
const stateCode = (r: string) => "FIRST_FROM_STATE_" + r.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "")

function buildHtml(name: string, state: string): string {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:20px;overflow:hidden;border:1px solid #1a1a1a">
    <div style="background:linear-gradient(135deg,#0f0f0f,#1a1100);padding:30px 40px;border-bottom:1px solid #1a1a1a">
      <span style="font-size:22px;font-weight:900;font-style:italic;letter-spacing:-0.05em;color:${ACCENT}">Kaiveron</span>
    </div>
    <div style="padding:40px">
      <p style="color:${ACCENT};font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.2em;margin:0 0 12px">Founding member · ${esc(state)}</p>
      <h1 style="color:#fff;font-size:27px;font-weight:900;margin:0 0 18px;font-style:italic;letter-spacing:-0.02em;line-height:1.15">You got to ${esc(state)} first, ${esc(name)}.</h1>
      <p style="color:#aaa;line-height:1.7;margin:0 0 18px">Out of everyone in ${esc(state)}, you joined Kaiveron first — genuinely #1 in your state. That makes you a <strong style="color:#fff">founding member</strong> here.</p>
      <p style="color:#aaa;line-height:1.7;margin:0 0 22px">I'm building Kaiveron with the people who showed up early, and in ${esc(state)} that's you. Would you help shape the community there?</p>
      <div style="background:#0f0f0f;border:1px solid #1f1a08;border-radius:16px;padding:20px 22px;margin:0 0 22px">
        <p style="color:${ACCENT};font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.15em;margin:0 0 12px">Your move this week — pick one (5 min)</p>
        <p style="color:#ddd;font-size:14px;line-height:1.7;margin:0">▸ Post about an anime you'd defend with your life<br>▸ Or start a club for your favourite series &amp; invite 2 friends</p>
      </div>
      <p style="color:#aaa;line-height:1.7;margin:0 0 24px">Do that and you're <strong style="color:#fff">${esc(state)}'s founding voice</strong> on Kaiveron — you'll carry a <strong style="color:${ACCENT}">"First from ${esc(state)}"</strong> badge on your profile, and a direct line to me for anything you'd want changed.</p>
      <a href="https://kaiveron.com" style="display:inline-block;padding:15px 32px;background:linear-gradient(135deg,#fbbf24,${ACCENT});color:#000;text-decoration:none;border-radius:12px;font-weight:900;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;box-shadow:0 8px 24px rgba(245,158,11,0.25)">Open Kaiveron →</a>
      <p style="color:#666;font-size:13px;line-height:1.6;margin:28px 0 0">If you're in, just reply to this email. Glad you found us first. 🧡<br><span style="color:#444">— Kaiveron</span></p>
    </div>
    <div style="padding:22px 40px;background:#050505;border-top:1px solid #1a1a1a">
      <p style="color:#444;font-size:11px;margin:0">You're getting this because you're an early ${esc(state)} member of Kaiveron.</p>
    </div>
  </div>`
}

async function main() {
  const send = process.argv.includes("--send")
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; username: string; displayName: string; email: string; region: string }>>(`
    SELECT DISTINCT ON (region) id, username, "displayName", email, region
    FROM "User"
    WHERE country='IN' AND region IS NOT NULL
      AND email NOT LIKE '%@kaiveron.com' AND email NOT LIKE '%@example.com'
      AND email NOT LIKE '%@preparmy.com' AND username <> 'kaiveron'
    ORDER BY region, "createdAt" ASC`)

  console.log(`${rows.length} state-first members${send ? "" : "  (DRY RUN — pass --send)"}:`)
  for (const r of rows) console.log(`  ${cleanState(r.region)} → ${r.displayName} <${r.email}>  [${stateCode(r.region)}]`)
  if (!send) { await prisma.$disconnect(); return }

  const port = Number(process.env.SMTP_PORT || 465)
  const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } })
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER

  for (const r of rows) {
    const state = cleanState(r.region)
    const name = (r.displayName || r.username).trim().split(/\s+/)[0]
    // 1) grant badge (idempotent)
    await prisma.userBadge.upsert({ where: { userId_code: { userId: r.id, code: stateCode(r.region) } }, create: { userId: r.id, code: stateCode(r.region) }, update: {} })
    // 2) send email
    const subject = `You're Kaiveron's first member from ${state}`
    const text = `Hey ${name},\n\nOut of everyone in ${state}, you joined Kaiveron first — genuinely #1 in your state, which makes you a founding member here.\n\nI'm building Kaiveron with the people who showed up early, and in ${state} that's you. Would you help shape the community there?\n\nThis week, pick one (5 min): post about an anime you love, or start a club for your favourite series and invite 2 friends.\n\nDo that and you're ${state}'s founding voice on Kaiveron — you'll carry a "First from ${state}" badge on your profile, and a direct line to me.\n\nIf you're in, just reply. Glad you found us first.\n\n— Kaiveron`
    const info = await t.sendMail({ from: `"Kaiveron" <${from}>`, to: r.email, replyTo: "chandrapriyanshu10@gmail.com", subject, text, html: buildHtml(name, state) })
    console.log(`✓ ${state}: badge + email → ${r.email}  ${info.messageId}`)
    await new Promise((res) => setTimeout(res, 1200))
  }
  await prisma.$disconnect()
  console.log("Done.")
}
main().catch((e) => { console.error(e); process.exit(1) })
