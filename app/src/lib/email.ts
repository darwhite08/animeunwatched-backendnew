type EmailOpts = {
  to: string
  subject: string
  html: string
}

export async function sendEmail(opts: EmailOpts): Promise<void> {
  if (process.env.NODE_ENV !== "production") {
    console.log(`[EMAIL STUB] To: ${opts.to} | Subject: ${opts.subject}`)
    return
  }
  // TODO: implement with nodemailer or SendGrid
}

export function welcomeEmail(email: string, displayName: string): EmailOpts {
  return {
    to: email,
    subject: "Welcome to AnimeUnwatched, Shinobi",
    html: `<h1>Welcome, ${displayName}</h1><p>Your neural archive is ready.</p>`,
  }
}

export function streakReminderEmail(email: string, displayName: string, streakDays: number): EmailOpts {
  return {
    to: email,
    subject: `Don't break your ${streakDays}-day streak!`,
    html: `<h1>Hey ${displayName}</h1><p>Log an episode today to keep your ${streakDays}-day streak alive.</p>`,
  }
}

export function weeklyDigestEmail(email: string, displayName: string, topAnime: string[]): EmailOpts {
  return {
    to: email,
    subject: "Your Weekly Anime Digest",
    html: `<h1>Hey ${displayName}</h1><p>Top picks this week:</p><ul>${topAnime.map(a => `<li>${a}</li>`).join("")}</ul>`,
  }
}
