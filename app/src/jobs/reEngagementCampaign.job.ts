import { prisma } from "../config/prisma"
import { sendEmail, reengagementCampaignEmail, isEmailConfigured } from "../lib/email"

// Win-back inactive users with a fresh FOMO email. Guardrails:
//  - only verified, deliverable real emails (test/synthetic domains excluded)
//  - inactive 7+ days
//  - per-user cooldown (won't re-email within COOLDOWN_DAYS)
//  - capped per run + throttled sends to protect domain reputation
const INACTIVE_DAYS = 7
const COOLDOWN_DAYS = 14
const MAX_PER_RUN = 100
const SEND_DELAY_MS = 1500

// Email domains that aren't real mailboxes — never send to these.
const SYNTHETIC = ["@t.kaiveron.com", "@test.kaiveron.com", "@kaiveron.com", "@example.com", "preparmy.com"]

const firstImage = (html: string): string | null => {
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i)
  return m?.[1] ?? null
}

export async function runReEngagementCampaign(): Promise<{ sent: number; skipped: number }> {
  if (!isEmailConfigured()) return { sent: 0, skipped: 0 } // inert until SMTP is set

  const now = Date.now()
  const inactiveBefore = new Date(now - INACTIVE_DAYS * 24 * 60 * 60_000)
  const cooldownBefore = new Date(now - COOLDOWN_DAYS * 24 * 60 * 60_000)

  const recipients = await prisma.user.findMany({
    where: {
      isBanned: false,
      emailVerifiedAt: { not: null },        // only confirmed, deliverable addresses
      AND: [
        { OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: inactiveBefore } }] },
        { OR: [{ lastReengagedAt: null }, { lastReengagedAt: { lt: cooldownBefore } }] },
        ...SYNTHETIC.map((d) => ({ email: { not: { contains: d } } })),
      ],
    },
    select: { id: true, email: true, displayName: true, username: true },
    take: MAX_PER_RUN,
  })
  if (recipients.length === 0) return { sent: 0, skipped: 0 }

  // Fresh content: latest published blog + its first image, top 3 anime by score.
  const blog = await prisma.blog.findFirst({
    where: { status: "PUBLISHED" },
    orderBy: { createdAt: "desc" },
    select: { slug: true, title: true, body: true },
  })
  if (!blog) return { sent: 0, skipped: 0 }
  const featured = { slug: blog.slug, title: blog.title, image: firstImage(blog.body ?? "") }

  const trending = await prisma.anime.findMany({
    where: { score: { not: null } },
    orderBy: { score: "desc" },
    take: 3,
    select: { title: true, score: true },
  })

  let sent = 0
  for (const u of recipients) {
    const name = (u.displayName || u.username || u.email.split("@")[0]).trim().split(/\s+/)[0]
    try {
      await sendEmail(reengagementCampaignEmail(u.email, name, featured, trending))
      await prisma.user.update({ where: { id: u.id }, data: { lastReengagedAt: new Date() } })
      sent++
    } catch (err) {
      console.error("[reEngagement] failed for", u.email, err)
    }
    await new Promise((r) => setTimeout(r, SEND_DELAY_MS))
  }

  console.log(`[Job] Re-engagement campaign sent ${sent}/${recipients.length}`)
  return { sent, skipped: recipients.length - sent }
}
