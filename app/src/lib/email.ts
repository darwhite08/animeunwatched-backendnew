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

export function welcomeEmail(email: string, displayName: string): EmailOpts {
  return {
    to: email,
    subject: "Welcome to AnimeUnwatched, Shinobi",
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#020202;color:#fff;padding:40px;border-radius:16px">
        <h1 style="color:#6366f1;font-size:28px;margin-bottom:16px">Welcome, ${displayName}!</h1>
        <p style="color:#aaa;line-height:1.6">Your neural archive is ready. Start tracking anime, join communities, and discover hidden gems.</p>
        <a href="https://animeunwatched.com/dashboard" style="display:inline-block;margin-top:24px;padding:12px 24px;background:#6366f1;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold">Go to Dashboard</a>
        <p style="color:#555;font-size:12px;margin-top:32px">You're receiving this because you created an account at AnimeUnwatched.</p>
      </div>
    `,
  }
}

export function streakReminderEmail(email: string, displayName: string, streakDays: number): EmailOpts {
  return {
    to: email,
    subject: `⚡ Don't break your ${streakDays}-day streak!`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#020202;color:#fff;padding:40px;border-radius:16px">
        <h1 style="color:#f97316;font-size:28px;margin-bottom:16px">Streak Alert!</h1>
        <p style="color:#aaa;line-height:1.6">Hey ${displayName}, your ${streakDays}-day streak is at risk! Log an episode today to keep the flame alive.</p>
        <a href="https://animeunwatched.com/dashboard" style="display:inline-block;margin-top:24px;padding:12px 24px;background:#f97316;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold">Keep Streak Alive</a>
      </div>
    `,
  }
}

export function weeklyDigestEmail(email: string, displayName: string, topAnime: string[]): EmailOpts {
  const animeList = topAnime.slice(0, 5).map(a => `<li style="margin:8px 0;color:#aaa">${a}</li>`).join("");
  return {
    to: email,
    subject: "🎌 Your Weekly Anime Digest",
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#020202;color:#fff;padding:40px;border-radius:16px">
        <h1 style="color:#6366f1;font-size:28px;margin-bottom:16px">Your Weekly Digest</h1>
        <p style="color:#aaa;line-height:1.6">Hey ${displayName}, here are your top picks this week:</p>
        <ul style="padding-left:20px">${animeList}</ul>
        <a href="https://animeunwatched.com/seasonal" style="display:inline-block;margin-top:24px;padding:12px 24px;background:#6366f1;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold">Discover More</a>
      </div>
    `,
  }
}
