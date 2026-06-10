import nodemailer from "nodemailer";
import { env } from "../config/env";

type EmailOpts = {
  to: string
  subject: string
  html: string
}

// Lazily create transporter so it doesn't fail on startup if SMTP is not configured
let _transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  });
  return _transporter;
}

export async function sendEmail(opts: EmailOpts): Promise<void> {
  if (env.NODE_ENV !== "production" || !env.ENABLE_EMAIL_NOTIFICATIONS) {
    if (env.NODE_ENV !== "production") {
      console.log(`[EMAIL STUB] To: ${opts.to} | Subject: ${opts.subject}`)
    }
    return
  }

  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    console.warn("[Email] SMTP not configured — skipping email send");
    return;
  }

  try {
    await getTransporter().sendMail({
      from: `"AnimeUnwatched" <${env.SMTP_USER}>`,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    });
  } catch (err) {
    console.error("[Email] Failed to send email:", err);
    // Don't throw — email failure should never break user-facing flows
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

export function welcomeEmail(email: string, displayName: string): EmailOpts {
  return {
    to: email,
    subject: `Welcome to ${BRAND_NAME}, ${displayName}`,
    html: emailBase(`
      <h1 style="color:#fff;font-size:26px;font-weight:900;margin:0 0 16px;font-style:italic">Welcome to the archive, ${displayName}!</h1>
      <p style="color:#aaa;line-height:1.7;margin-bottom:24px">
        Your Kaiveron profile is live. Here's what to do next:
      </p>
      <ol style="color:#aaa;line-height:2;padding-left:20px">
        <li>Complete your <strong style="color:#fff">onboarding</strong> to pick your watcher type</li>
        <li>Add <strong style="color:#fff">5+ anime</strong> to your watchlist to unlock your DNA chart</li>
        <li>Join a <strong style="color:#fff">club</strong> to find your community</li>
      </ol>
      <a href="${BRAND_URL}/onboarding" style="display:inline-block;margin-top:28px;padding:14px 28px;background:linear-gradient(135deg,#fbbf24,${ACCENT});color:#000;text-decoration:none;border-radius:12px;font-weight:900;font-size:13px;letter-spacing:0.05em;text-transform:uppercase">Build Your Archive →</a>
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
