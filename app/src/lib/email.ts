import { env } from "../config/env";
import { deliverEmail, emailTransportConfigured } from "./deliver";

type EmailOpts = {
  to: string
  subject: string
  html: string
  // Extra headers (e.g. List-Unsubscribe for deliverability). Optional.
  headers?: Record<string, string>
}

/**
 * Whether a real email would actually be delivered right now. This is the single
 * gate that decides if email-verification enforcement is active: if mail can't
 * leave the building, we must NOT block signups on a code they'll never receive.
 * Mirrors the exact conditions under which sendEmail() does real work.
 */
export function isEmailConfigured(): boolean {
  return (
    env.NODE_ENV === "production" &&
    !!env.ENABLE_EMAIL_NOTIFICATIONS &&
    emailTransportConfigured()
  );
}

export async function sendEmail(opts: EmailOpts): Promise<void> {
  if (env.NODE_ENV !== "production" || !env.ENABLE_EMAIL_NOTIFICATIONS) {
    if (env.NODE_ENV !== "production") {
      console.log(`[EMAIL STUB] To: ${opts.to} | Subject: ${opts.subject}`)
    }
    return
  }

  if (!emailTransportConfigured()) {
    console.warn("[Email] no transport configured — skipping email send");
    return;
  }

  // Prefer an explicit From address; fall back to the SMTP username for
  // plain mailbox SMTP. (Resend/SES use a non-email SMTP_USER, so EMAIL_FROM
  // must be set to a verified sender there.)
  const fromAddress = env.EMAIL_FROM || env.SMTP_USER;
  const res = await deliverEmail({
    from: `"Kaiveron" <${fromAddress}>`,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    headers: opts.headers,
  });
  if (!res.ok) {
    // Don't throw — email failure should never break user-facing flows.
    console.error(`[Email] Failed to send via ${res.via}: ${res.error}`);
  }
}

const BRAND_NAME = "Kaiveron"
const BRAND_URL  = "https://kaiveron.com"
const ACCENT     = "#f59e0b"

function emailBase(content: string): string {
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:20px;overflow:hidden;border:1px solid #1a1a1a">
      <div style="background:linear-gradient(135deg,#0f0f0f,#1a1100);padding:32px 40px;border-bottom:1px solid #1a1a1a">
        <span style="font-size:22px;font-weight:900;font-style:italic;letter-spacing:-0.05em;color:${ACCENT}">${BRAND_NAME}</span>
      </div>
      <div style="padding:40px">${content}</div>
      <div style="padding:24px 40px;background:#050505;border-top:1px solid #1a1a1a">
        <p style="color:#444;font-size:11px;margin:0">You're receiving this because you created a ${BRAND_NAME} account. <a href="${BRAND_URL}/me/settings/notifications" style="color:#666">Manage preferences</a></p>
      </div>
    </div>
  `
}

export function verificationEmail(email: string, displayName: string, code: string): EmailOpts {
  // Space the 6 digits so they're easy to read off a phone and hard to misread.
  const spaced = code.split("").join(" ")
  return {
    to: email,
    subject: `${code} is your ${BRAND_NAME} verification code`,
    html: emailBase(`
      <h1 style="color:#fff;font-size:26px;font-weight:900;margin:0 0 16px;font-style:italic">Confirm your email</h1>
      <p style="color:#aaa;line-height:1.7;margin:0 0 28px">
        Hey <strong style="color:#fff">${displayName}</strong> — enter this code in Kaiveron to verify your email and activate your account.
      </p>
      <div style="text-align:center;margin:0 0 28px">
        <div style="display:inline-block;padding:20px 32px;background:#0f0f0f;border:1px solid #1a1a1a;border-radius:16px;font-size:34px;font-weight:900;letter-spacing:0.35em;color:${ACCENT};font-family:'SF Mono',ui-monospace,Menlo,monospace">${spaced}</div>
      </div>
      <p style="color:#666;font-size:13px;line-height:1.6;margin:0">
        This code expires in 15 minutes. If you didn't create a Kaiveron account, you can safely ignore this email.
      </p>
    `),
  }
}

export function welcomeEmail(email: string, displayName: string): EmailOpts {
  // A numbered "next step" card — keeps the onboarding path obvious.
  const step = (n: number, title: string, body: string) => `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid #1a1a1a;vertical-align:top">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="width:38px;vertical-align:top">
            <div style="width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#fbbf24,${ACCENT});color:#000;font-weight:900;font-size:14px;text-align:center;line-height:30px">${n}</div>
          </td>
          <td style="vertical-align:top;padding-left:4px">
            <div style="color:#fff;font-size:14px;font-weight:800;margin-bottom:2px">${title}</div>
            <div style="color:#888;font-size:13px;line-height:1.5">${body}</div>
          </td>
        </tr></table>
      </td>
    </tr>`

  return {
    to: email,
    subject: `Welcome to ${BRAND_NAME}, ${displayName} — your archive is live`,
    html: emailBase(`
      <p style="color:${ACCENT};font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.2em;margin:0 0 10px">Welcome to the network</p>
      <h1 style="color:#fff;font-size:28px;font-weight:900;margin:0 0 14px;font-style:italic;letter-spacing:-0.02em">Welcome, ${displayName}.</h1>
      <p style="color:#aaa;line-height:1.7;margin:0 0 28px">
        Your ${BRAND_NAME} profile is live and your email is confirmed. ${BRAND_NAME} is where you track, rate, and discover anime — and find the people who love it like you do. Three quick steps to make it yours:
      </p>

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 4px">
        ${step(1, "Finish onboarding", "Pick your watcher type so your feed and recommendations fit you from day one.")}
        ${step(2, "Add 5+ anime", "Build your watchlist to unlock your taste DNA chart and smarter AI picks.")}
        ${step(3, "Join a club", "Find your community — episode threads, clubs, and creators worth following.")}
      </table>

      <a href="${BRAND_URL}/onboarding" style="display:inline-block;margin-top:30px;padding:15px 30px;background:linear-gradient(135deg,#fbbf24,${ACCENT});color:#000;text-decoration:none;border-radius:12px;font-weight:900;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;box-shadow:0 8px 24px rgba(245,158,11,0.25)">Build Your Archive →</a>

      <p style="color:#555;font-size:12px;line-height:1.6;margin:30px 0 0">
        Need a hand? Just reply to this email or visit <a href="${BRAND_URL}" style="color:#888">${BRAND_NAME.toLowerCase()}.com</a>. Glad you're here.
      </p>
    `),
  }
}

export function streakReminderEmail(email: string, displayName: string, streakDays: number): EmailOpts {
  return {
    to: email,
    subject: `Your ${streakDays}-day streak is at risk — log today`,
    html: emailBase(`
      <h1 style="color:#f97316;font-size:26px;font-weight:900;margin:0 0 16px">Streak Alert</h1>
      <p style="color:#aaa;line-height:1.7;margin-bottom:24px">
        Hey <strong style="color:#fff">${displayName}</strong> — you've built a <strong style="color:#f97316">${streakDays}-day streak</strong>. Log anything today to keep it alive.
      </p>
      <a href="${BRAND_URL}/watchlist" style="display:inline-block;padding:14px 28px;background:#f97316;color:#fff;text-decoration:none;border-radius:12px;font-weight:900;font-size:13px;letter-spacing:0.05em;text-transform:uppercase">Keep Streak Alive →</a>
    `),
  }
}

export function weeklyDigestEmail(email: string, displayName: string, topAnime: string[], friendActivity?: { name: string; watched: string }[]): EmailOpts {
  const animeListHtml = topAnime.slice(0, 5).map((a, i) =>
    `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #1a1a1a">
       <span style="color:${ACCENT};font-weight:900;font-size:12px;min-width:20px">${i + 1}</span>
       <span style="color:#ddd;font-size:14px">${a}</span>
     </div>`
  ).join("")

  const friendHtml = (friendActivity ?? []).slice(0, 3).map(f =>
    `<p style="color:#aaa;font-size:13px;margin:6px 0"><strong style="color:#fff">${f.name}</strong> watched <em style="color:${ACCENT}">${f.watched}</em></p>`
  ).join("") || `<p style="color:#555;font-size:13px">Follow more users to see their activity here.</p>`

  return {
    to: email,
    subject: `Your ${BRAND_NAME} Weekly Digest`,
    html: emailBase(`
      <h1 style="color:#fff;font-size:26px;font-weight:900;margin:0 0 8px">Weekly Digest</h1>
      <p style="color:#555;font-size:12px;margin:0 0 28px;text-transform:uppercase;letter-spacing:0.1em">${displayName} • This Week</p>

      <h3 style="color:${ACCENT};font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.15em;margin:0 0 12px">Trending This Week</h3>
      ${animeListHtml}

      <h3 style="color:${ACCENT};font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.15em;margin:28px 0 12px">Friends Activity</h3>
      ${friendHtml}

      <a href="${BRAND_URL}/calendar" style="display:inline-block;margin-top:28px;padding:14px 28px;background:linear-gradient(135deg,#fbbf24,${ACCENT});color:#000;text-decoration:none;border-radius:12px;font-weight:900;font-size:13px;letter-spacing:0.05em;text-transform:uppercase">See This Season →</a>
    `),
  }
}

export function reEngagementEmail(email: string, displayName: string, daysSince: number, suggestions: string[]): EmailOpts {
  const suggestionsHtml = suggestions.slice(0, 3).map(s =>
    `<div style="padding:10px 0;border-bottom:1px solid #1a1a1a;color:#ddd;font-size:14px">${s}</div>`
  ).join("")

  return {
    to: email,
    subject: `We miss you, ${displayName} — ${daysSince} days since your last watch`,
    html: emailBase(`
      <h1 style="color:#fff;font-size:26px;font-weight:900;margin:0 0 16px">Good to see you back</h1>
      <p style="color:#aaa;line-height:1.7;margin-bottom:24px">
        It's been <strong style="color:#fff">${daysSince} days</strong>. A lot happened in the anime world. Here's what's waiting for you:
      </p>
      ${suggestionsHtml}
      <a href="${BRAND_URL}/mood" style="display:inline-block;margin-top:28px;padding:14px 28px;background:linear-gradient(135deg,#fbbf24,${ACCENT});color:#000;text-decoration:none;border-radius:12px;font-weight:900;font-size:13px;letter-spacing:0.05em;text-transform:uppercase">Pick Your Mood →</a>
    `),
  }
}

/**
 * FOMO-style re-engagement email for the recurring win-back campaign. Features
 * the latest blog + a trending-anime list (passed in by the job so the content
 * is always fresh).
 */
export function reengagementCampaignEmail(
  email: string,
  name: string,
  blog: { slug: string; title: string; image: string | null },
  trending: Array<{ title: string; score: number | null }>,
): EmailOpts {
  const blogUrl = `${BRAND_URL}/blog/${blog.slug}`
  const rows = trending.slice(0, 3).map(a =>
    `<tr><td style="padding:9px 0;border-bottom:1px solid #161616"><span style="color:#fff;font-size:14px;font-weight:700">${a.title}</span></td>
     <td style="padding:9px 0;border-bottom:1px solid #161616;text-align:right;white-space:nowrap"><span style="color:${ACCENT};font-weight:900;font-size:13px">★ ${a.score?.toFixed(1) ?? "—"}</span></td></tr>`
  ).join("")
  const topScore = trending[0]?.score?.toFixed(1) ?? "9.0"

  return {
    to: email,
    subject: `${name}, you're missing the #1 anime right now (and what's new)`,
    html: emailBase(`
      <p style="color:${ACCENT};font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.2em;margin:0 0 10px">While you were gone</p>
      <h1 style="color:#fff;font-size:28px;font-weight:900;margin:0 0 14px;font-style:italic;letter-spacing:-0.02em">${name}, the anime world didn't wait. 👀</h1>
      <p style="color:#aaa;line-height:1.7;margin:0 0 28px">New drops, hot takes and the season's biggest releases have been piling up on Kaiveron. Here's the 2-minute catch-up:</p>
      <table role="presentation" width="100%" style="margin:0 0 28px"><tr>
        <td style="text-align:center;padding:14px 6px;background:#0f0f0f;border:1px solid #1a1a1a;border-radius:12px"><div style="color:${ACCENT};font-size:22px;font-weight:900">${topScore}★</div><div style="color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.1em">Top anime now</div></td>
        <td style="width:10px"></td>
        <td style="text-align:center;padding:14px 6px;background:#0f0f0f;border:1px solid #1a1a1a;border-radius:12px"><div style="color:${ACCENT};font-size:22px;font-weight:900">30k</div><div style="color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.1em">Anime tracked</div></td>
      </tr></table>
      <a href="${blogUrl}" style="display:block;border:1px solid #1a1a1a;border-radius:16px;overflow:hidden;text-decoration:none;background:#0f0f0f">
        ${blog.image ? `<img src="${blog.image}" alt="" width="600" style="width:100%;height:auto;display:block"/>` : ""}
        <div style="padding:18px 20px"><span style="color:${ACCENT};font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:0.18em">The Chronicle</span><div style="color:#fff;font-size:17px;font-weight:800;margin:8px 0 0;line-height:1.35">${blog.title}</div></div>
      </a>
      ${rows ? `<p style="color:#fff;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:0.15em;margin:30px 0 6px">🔥 Trending right now</p><table role="presentation" width="100%">${rows}</table>` : ""}
      <a href="${BRAND_URL}/community" style="display:inline-block;margin-top:30px;padding:15px 30px;background:linear-gradient(135deg,#fbbf24,${ACCENT});color:#000;text-decoration:none;border-radius:12px;font-weight:900;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;box-shadow:0 8px 24px rgba(245,158,11,0.25)">Catch up now →</a>
      <p style="color:#555;font-size:12px;margin:24px 0 0">Your watchlist and streak are waiting — pick them back up.</p>
    `),
  }
}

/**
 * Offline "new message" notification — sent by the messageEmailDigest job to a
 * recipient who has unread DMs and is not currently online. It BATCHES every
 * unread conversation into one email (never one email per message) and carries a
 * List-Unsubscribe header so it stays deliverable. See the job for the cadence/
 * throttle rules that decide WHEN this is sent.
 */
export function newMessageEmail(
  email: string,
  name: string,
  senders: Array<{ name: string; preview: string; unread: number }>,
  totalUnread: number,
  unsubUrl?: string,
): EmailOpts {
  const people = senders.length
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

  const headline =
    people === 1
      ? `${esc(senders[0].name)} messaged you`
      : `${totalUnread} new messages from ${people} people`

  const rows = senders.slice(0, 6).map((s) =>
    `<tr><td style="padding:14px 0;border-bottom:1px solid #1a1a1a;vertical-align:top">
       <div style="color:#fff;font-size:14px;font-weight:800;margin-bottom:3px">
         ${esc(s.name)}${s.unread > 1 ? `<span style="color:${ACCENT};font-weight:900;font-size:12px"> · ${s.unread} new</span>` : ""}
       </div>
       <div style="color:#888;font-size:13px;line-height:1.5">${esc(s.preview)}</div>
     </td></tr>`
  ).join("")
  const more = people > 6 ? `<p style="color:#555;font-size:12px;margin:14px 0 0">…and ${people - 6} more conversation${people - 6 === 1 ? "" : "s"}.</p>` : ""

  const subject =
    people === 1
      ? `${senders[0].name} sent you a message on ${BRAND_NAME}`
      : `You have ${totalUnread} unread messages on ${BRAND_NAME}`

  return {
    to: email,
    subject,
    // RFC 8058 one-click unsubscribe when we have a signed URL; the GET also
    // works for human clicks. Falls back to the settings page + mailto otherwise.
    headers: unsubUrl
      ? { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
      : { "List-Unsubscribe": `<${BRAND_URL}/me/settings/notifications>, <mailto:unsubscribe@kaiveron.com?subject=unsubscribe-messages>` },
    html: emailBase(`
      <p style="color:${ACCENT};font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.2em;margin:0 0 10px">New on Kaiveron</p>
      <h1 style="color:#fff;font-size:26px;font-weight:900;margin:0 0 8px;font-style:italic;letter-spacing:-0.02em">${headline}</h1>
      <p style="color:#aaa;line-height:1.7;margin:0 0 24px">Hey <strong style="color:#fff">${esc(name)}</strong> — you've got unread messages waiting while you were away.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows}</table>
      ${more}
      <a href="${BRAND_URL}/messages" style="display:inline-block;margin-top:28px;padding:14px 28px;background:linear-gradient(135deg,#fbbf24,${ACCENT});color:#000;text-decoration:none;border-radius:12px;font-weight:900;font-size:13px;letter-spacing:0.05em;text-transform:uppercase">Open Messages →</a>
      <p style="color:#555;font-size:12px;line-height:1.6;margin:26px 0 0">You're getting this because someone messaged you on ${BRAND_NAME} and you weren't online. Turn these off anytime under <a href="${BRAND_URL}/me/settings/notifications" style="color:#888">notification settings</a>.</p>
    `),
  }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * Congrats email when a user is granted the Verified Creator badge. A one-time,
 * triggered transactional email (fired on the transition into CREATOR). Warm +
 * celebratory, leads with the achievement, and points at what it unlocks.
 */
export function creatorBadgeEmail(email: string, displayName: string, repBonus = 0): EmailOpts {
  const name = escapeHtml(displayName || "there")
  const perk = (title: string, body: string) => `
    <tr><td style="padding:12px 0;border-bottom:1px solid #1a1a1a;vertical-align:top">
      <div style="color:#fff;font-size:14px;font-weight:800;margin-bottom:2px">${title}</div>
      <div style="color:#888;font-size:13px;line-height:1.5">${body}</div>
    </td></tr>`
  return {
    to: email,
    subject: `You're a Verified Creator on ${BRAND_NAME} 🎉`,
    html: emailBase(`
      <p style="color:${ACCENT};font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.2em;margin:0 0 10px">Verified Creator</p>
      <h1 style="color:#fff;font-size:28px;font-weight:900;margin:0 0 14px;font-style:italic;letter-spacing:-0.02em">Congrats, ${name} — you're verified. 🎉</h1>
      <p style="color:#aaa;line-height:1.7;margin:0 0 24px">
        Your ${BRAND_NAME} profile now carries the <strong style="color:#fff">Verified Creator</strong> seal. It's a signal to the whole community that your voice is the real deal — and it unlocks the creator toolkit:
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 8px">
        ${perk("The verified seal on your profile", "Your badge shows everywhere your name appears — posts, comments, clubs and search.")}
        ${perk("Creator Studio", "Deep analytics, audience insights, your content dashboard and monetization tools.")}
        ${perk("Stand out", "Verified creators get more reach and trust across feeds and recommendations.")}
        ${repBonus > 0 ? perk(`+${repBonus} reputation`, "A welcome boost to your standing on the leaderboard — added to your profile already.") : ""}
      </table>
      <a href="https://creator-studio.kaiveron.com" style="display:inline-block;margin-top:28px;padding:15px 30px;background:linear-gradient(135deg,#fbbf24,${ACCENT});color:#000;text-decoration:none;border-radius:12px;font-weight:900;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;box-shadow:0 8px 24px rgba(245,158,11,0.25)">Open Creator Studio →</a>
      <p style="color:#555;font-size:12px;line-height:1.6;margin:28px 0 0">Welcome to the creator side of ${BRAND_NAME}. We can't wait to see what you make. 🧡</p>
    `),
  }
}

/**
 * Congrats email for the Founding Creator badge — one of the first 250 verified
 * creators ever. The serial ("#N of 250") is the hook: scarcity = status. Sent
 * once, only when the badge is newly issued.
 */
export function foundingBadgeEmail(email: string, displayName: string, serial: number, repBonus = 0): EmailOpts {
  const name = escapeHtml(displayName || "there")
  return {
    to: email,
    subject: `You're Founding Creator #${serial} on ${BRAND_NAME} ⚡`,
    html: emailBase(`
      <p style="color:${ACCENT};font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.2em;margin:0 0 10px">Founding Creator · Limited to 250</p>
      <h1 style="color:#fff;font-size:28px;font-weight:900;margin:0 0 6px;font-style:italic;letter-spacing:-0.02em">${name}, you're one of the first. ⚡</h1>
      <div style="text-align:center;margin:22px 0 26px">
        <div style="display:inline-block;padding:22px 40px;background:#0f0f0f;border:1px solid #2a1f00;border-radius:18px">
          <div style="color:#888;font-size:10px;text-transform:uppercase;letter-spacing:0.25em;margin-bottom:6px">Founding Creator</div>
          <div style="color:${ACCENT};font-size:40px;font-weight:900;font-style:italic;letter-spacing:-0.03em">#${serial}<span style="color:#555;font-size:18px;font-weight:700"> / 250</span></div>
        </div>
      </div>
      <p style="color:#aaa;line-height:1.7;margin:0 0 22px">
        This is the rarest badge on ${BRAND_NAME}. You became a Verified Creator early enough to claim a permanent <strong style="color:#fff">Founding Creator</strong> seal — only ever given to the first 250 people. It's yours for good, serial number and all.
      </p>
      <p style="color:#aaa;line-height:1.7;margin:0 0 22px">
        You also get everything a Verified Creator does: the verified seal across the app, Creator Studio analytics, and monetization tools${repBonus > 0 ? `, plus a <strong style="color:#fff">+${repBonus} reputation</strong> welcome boost (already on your profile)` : ""}. But the founding mark? That one says you were here at the start.
      </p>
      <a href="https://creator-studio.kaiveron.com" style="display:inline-block;padding:15px 30px;background:linear-gradient(135deg,#fbbf24,${ACCENT});color:#000;text-decoration:none;border-radius:12px;font-weight:900;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;box-shadow:0 8px 24px rgba(245,158,11,0.25)">Open Creator Studio →</a>
      <p style="color:#555;font-size:12px;line-height:1.6;margin:28px 0 0">Thank you for building ${BRAND_NAME} with us from day one. 🧡</p>
    `),
  }
}

/**
 * Congrats email for the Verified (USER) and Verified Studio (STUDIO) badges.
 * One-time, triggered on the transition into that badge.
 */
export function verifiedBadgeEmail(email: string, displayName: string, kind: "USER" | "STUDIO"): EmailOpts {
  const name = escapeHtml(displayName || "there")
  const isStudio = kind === "STUDIO"
  const label = isStudio ? "Verified Studio" : "Verified"
  const lede = isStudio
    ? `Your studio is now <strong style="color:#fff">Verified</strong> on ${BRAND_NAME} — the official seal that tells fans this is the real, authentic home of your studio.`
    : `Your account is now <strong style="color:#fff">Verified</strong> on ${BRAND_NAME} — a seal of authenticity that shows the community you're the real you.`
  return {
    to: email,
    subject: isStudio ? `Your studio is verified on ${BRAND_NAME} ✓` : `You're verified on ${BRAND_NAME} ✓`,
    html: emailBase(`
      <p style="color:${ACCENT};font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.2em;margin:0 0 10px">${label}</p>
      <h1 style="color:#fff;font-size:28px;font-weight:900;margin:0 0 14px;font-style:italic;letter-spacing:-0.02em">Congrats, ${name} — you're verified. ✓</h1>
      <p style="color:#aaa;line-height:1.7;margin:0 0 22px">${lede}</p>
      <p style="color:#aaa;line-height:1.7;margin:0 0 24px">The verified seal now appears everywhere your name shows up — posts, comments, clubs and search — so people always know it's genuinely you.</p>
      <a href="${BRAND_URL}/me" style="display:inline-block;padding:15px 30px;background:linear-gradient(135deg,#fbbf24,${ACCENT});color:#000;text-decoration:none;border-radius:12px;font-weight:900;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;box-shadow:0 8px 24px rgba(245,158,11,0.25)">View your profile →</a>
      <p style="color:#555;font-size:12px;line-height:1.6;margin:28px 0 0">Welcome to the verified side of ${BRAND_NAME}. 🧡</p>
    `),
  }
}

/**
 * Congrats email when a user is made a Community Lead (admin-granted role).
 * One-time, fired on the transition into the role.
 */
export function communityLeadEmail(email: string, displayName: string): EmailOpts {
  const name = escapeHtml(displayName || "there")
  return {
    to: email,
    subject: `You're now a Community Lead on ${BRAND_NAME} 🎉`,
    html: emailBase(`
      <p style="color:${ACCENT};font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.2em;margin:0 0 10px">Community Lead</p>
      <h1 style="color:#fff;font-size:28px;font-weight:900;margin:0 0 14px;font-style:italic;letter-spacing:-0.02em">Congrats, ${name} — you're a Community Lead. 🎉</h1>
      <p style="color:#aaa;line-height:1.7;margin:0 0 22px">
        You're now an official <strong style="color:#fff">Community Lead</strong> for anime &amp; manga on ${BRAND_NAME} — one of the people helping shape and steer the community: welcoming new members, sparking discussion, and being a trusted voice as we grow.
      </p>
      <p style="color:#aaa;line-height:1.7;margin:0 0 24px">Your <strong style="color:#fff">Community Lead</strong> flair now shows next to your name across the app. No heavy commitment — mostly doing what you already do, with a bit more reach.</p>
      <a href="${BRAND_URL}/me" style="display:inline-block;padding:15px 30px;background:linear-gradient(135deg,#fbbf24,${ACCENT});color:#000;text-decoration:none;border-radius:12px;font-weight:900;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;box-shadow:0 8px 24px rgba(245,158,11,0.25)">Open your profile →</a>
      <p style="color:#555;font-size:12px;line-height:1.6;margin:28px 0 0">Glad to have you steering the community. 🧡</p>
    `),
  }
}
