import { prisma } from "../config/prisma"
import { sendEmail, newMessageEmail, isEmailConfigured } from "../lib/email"
import { isOnline } from "../realtime/presence"

// Offline "new message" email notifications. This job is the WHEN behind the
// feature — it never sends one email per message. Research-backed cadence
// (Slack/Discord/IG pattern): email a recipient only if ALL hold:
//   - they have unread 1:1 DMs in an ACTIVE conversation
//   - the newest message has been unread for >= DEBOUNCE (gives them time to
//     read it live before we bother their inbox)
//   - they are NOT currently online (no point emailing someone who's in the app)
//   - the conversation isn't muted
//   - newer messages have arrived since we last emailed them about it (never
//     nag twice about the same unread batch — tracked via pXLastEmailedAt)
//   - they haven't been sent ANY message-email in the last GLOBAL_COOLDOWN
//     (hard anti-spam throttle; we BATCH every unread conversation into one mail)
//   - email is verified/deliverable, real, and they haven't opted out
//
// Runs every 5 min (see jobs/index.ts). Inert until SMTP is configured.

const DEBOUNCE_MS = 5 * 60_000          // unread for >= 5 min before we email
const LOOKBACK_MS = 24 * 60 * 60_000    // ignore conversations idle for > 24h
const GLOBAL_COOLDOWN_MS = 60 * 60_000  // at most one message-email per user / hour
const MAX_CONVERSATIONS = 1000          // scan cap per run
const MAX_RECIPIENTS = 200              // send cap per run (throttled)
const SEND_DELAY_MS = 1000              // pace sends to protect domain reputation
const PREVIEW_LEN = 90

// Email domains that aren't real mailboxes — never send to these.
const SYNTHETIC = ["@t.kaiveron.com", "@test.kaiveron.com", "@kaiveron.com", "@example.com", "preparmy.com"]

type LastMsg = {
  senderId: string
  body: string | null
  type: string
  deletedAt: Date | null
  isE2EE: boolean
  ciphertext: string | null
}

/** Human-readable one-line preview for a DM, respecting media/E2EE/deletion. */
function previewOf(m: LastMsg | undefined, senderId: string): string {
  if (!m || m.senderId !== senderId) return "Sent you a message"
  if (m.deletedAt) return "Message deleted"
  if (m.isE2EE || (m.ciphertext && !m.body)) return "🔒 Sent you an encrypted message"
  switch (m.type) {
    case "IMAGE": return "📷 Photo"
    case "VOICE": return "🎤 Voice message"
    case "ANIME_CARD": return "📺 Shared an anime"
    case "SYSTEM": return "Sent you an update"
    default: {
      const body = (m.body ?? "").replace(/\s+/g, " ").trim()
      if (!body) return "Sent you a message"
      return body.length > PREVIEW_LEN ? body.slice(0, PREVIEW_LEN - 1) + "…" : body
    }
  }
}

type Candidate = { conversationId: string; side: 1 | 2; senderName: string; preview: string; unread: number }
type Recipient = {
  id: string; email: string; displayName: string; username: string
  emailOnNewMessage: boolean; emailVerifiedAt: Date | null; isBanned: boolean
  lastMessageEmailAt: Date | null
}

export async function runMessageEmailNotifications(): Promise<{ sent: number; scanned: number }> {
  if (!isEmailConfigured()) return { sent: 0, scanned: 0 } // inert until SMTP is set

  const now = Date.now()
  const unreadBefore = new Date(now - DEBOUNCE_MS)   // newest msg must predate this
  const lookbackAfter = new Date(now - LOOKBACK_MS)  // …but still be recent
  const cooldownBefore = new Date(now - GLOBAL_COOLDOWN_MS)

  const convos = await prisma.conversation.findMany({
    where: {
      status: "ACTIVE",
      lastMessageAt: { gte: lookbackAfter, lte: unreadBefore },
      OR: [{ p1UnreadCount: { gt: 0 } }, { p2UnreadCount: { gt: 0 } }],
    },
    orderBy: { lastMessageAt: "desc" },
    take: MAX_CONVERSATIONS,
    select: {
      id: true, lastMessageAt: true,
      p1UnreadCount: true, p2UnreadCount: true,
      p1MutedUntil: true, p2MutedUntil: true,
      p1LastEmailedAt: true, p2LastEmailedAt: true,
      user1: { select: recipientSelect },
      user2: { select: recipientSelect },
      messages: {
        where: { deletedForRecipient: false },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { senderId: true, body: true, type: true, deletedAt: true, isE2EE: true, ciphertext: true },
      },
    },
  })

  // Group eligible conversations by recipient.
  const byRecipient = new Map<string, { user: Recipient; candidates: Candidate[] }>()
  const muted = (until: Date | null) => until != null && until.getTime() > now

  for (const c of convos) {
    const lastMsg = c.messages[0] as LastMsg | undefined
    const sides: Array<{ side: 1 | 2; recipient: Recipient; sender: Recipient; unread: number; mutedUntil: Date | null; lastEmailed: Date | null }> = [
      { side: 1, recipient: c.user1, sender: c.user2, unread: c.p1UnreadCount, mutedUntil: c.p1MutedUntil, lastEmailed: c.p1LastEmailedAt },
      { side: 2, recipient: c.user2, sender: c.user1, unread: c.p2UnreadCount, mutedUntil: c.p2MutedUntil, lastEmailed: c.p2LastEmailedAt },
    ]
    for (const s of sides) {
      if (s.unread <= 0) continue
      if (muted(s.mutedUntil)) continue
      // Only re-email when new messages arrived since the last email for this side.
      if (s.lastEmailed && c.lastMessageAt.getTime() <= s.lastEmailed.getTime()) continue
      if (isOnline(s.recipient.id)) continue // they're in the app — let realtime handle it

      const senderName = s.sender.displayName || s.sender.username || "Someone"
      const entry = byRecipient.get(s.recipient.id) ?? { user: s.recipient, candidates: [] }
      entry.candidates.push({
        conversationId: c.id, side: s.side, senderName,
        preview: previewOf(lastMsg, s.sender.id), unread: s.unread,
      })
      byRecipient.set(s.recipient.id, entry)
    }
  }

  let sent = 0
  let processed = 0
  for (const { user, candidates } of byRecipient.values()) {
    if (sent >= MAX_RECIPIENTS) break
    processed++

    // Per-recipient deliverability + anti-spam gates.
    if (!user.emailOnNewMessage) continue
    if (!user.emailVerifiedAt) continue
    if (user.isBanned) continue
    if (SYNTHETIC.some((d) => user.email.includes(d))) continue
    if (user.lastMessageEmailAt && user.lastMessageEmailAt.getTime() > cooldownBefore.getTime()) continue

    // Batch: one mail summarizing every unread conversation, biggest first.
    candidates.sort((a, b) => b.unread - a.unread)
    const totalUnread = candidates.reduce((n, c) => n + c.unread, 0)
    const firstName = (user.displayName || user.username || user.email.split("@")[0]).trim().split(/\s+/)[0]
    const senders = candidates.map((c) => ({ name: c.senderName, preview: c.preview, unread: c.unread }))

    try {
      await sendEmail(newMessageEmail(user.email, firstName, senders, totalUnread))
      const stamp = new Date()
      const p1Ids = candidates.filter((c) => c.side === 1).map((c) => c.conversationId)
      const p2Ids = candidates.filter((c) => c.side === 2).map((c) => c.conversationId)
      await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { lastMessageEmailAt: stamp } }),
        ...(p1Ids.length ? [prisma.conversation.updateMany({ where: { id: { in: p1Ids } }, data: { p1LastEmailedAt: stamp } })] : []),
        ...(p2Ids.length ? [prisma.conversation.updateMany({ where: { id: { in: p2Ids } }, data: { p2LastEmailedAt: stamp } })] : []),
      ])
      sent++
    } catch (err) {
      console.error("[messageEmail] failed for", user.email, err)
    }
    await new Promise((r) => setTimeout(r, SEND_DELAY_MS))
  }

  if (sent > 0) console.log(`[Job] Message-email notifications sent ${sent} (scanned ${convos.length} conversations, ${processed} recipients)`)
  return { sent, scanned: convos.length }
}

const recipientSelect = {
  id: true, email: true, displayName: true, username: true,
  emailOnNewMessage: true, emailVerifiedAt: true, isBanned: true, lastMessageEmailAt: true,
} as const
