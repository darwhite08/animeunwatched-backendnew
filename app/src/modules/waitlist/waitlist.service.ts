import { prisma } from "../../config/prisma";
import type { JoinWaitlistInput } from "./waitlist.schema";
import { getInviteOnly } from "../../lib/inviteGate";
import { sendMail } from "../../lib/mailer";
import { buildWaitlistInvite, waitlistInviteCtaUrl, WAITLIST_INVITE_FROM } from "../../lib/waitlistInviteEmail";

/**
 * Idempotent join — one row per email. Re-submitting the same email is a no-op
 * success (never leaks whether the email was already on the list).
 *
 * If the email already belongs to a registered member, we DON'T waitlist them —
 * `alreadyMember: true` is returned so the client can point them at sign-in
 * instead of telling an existing user they're "on the list".
 */
export async function joinWaitlist(
  input: JoinWaitlistInput,
): Promise<{ ok: true; alreadyOn: boolean; alreadyMember: boolean }> {
  // Already a registered member? Don't add them to the waitlist. Case-insensitive
  // match: User.email may be stored with original casing (register doesn't
  // lowercase it), while the waitlist email is normalized to lowercase.
  const member = await prisma.user.findFirst({
    where: { email: { equals: input.email, mode: "insensitive" } },
    select: { id: true },
  });
  if (member) return { ok: true, alreadyOn: false, alreadyMember: true };

  const existing = await prisma.waitlist.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) return { ok: true, alreadyOn: true, alreadyMember: false };

  await prisma.waitlist.create({
    data: {
      email:      input.email,
      source:     input.source ?? "register",
      referredBy: input.referredBy ?? null,
    },
  });
  return { ok: true, alreadyOn: false, alreadyMember: false };
}

/**
 * Delete any waitlist rows whose email now belongs to a registered member, so
 * the waitlist never shows someone who has already signed up / logged in.
 * Case-insensitive: User.email keeps its original casing while waitlist emails
 * are normalized to lowercase. Returns how many stale rows were removed.
 */
export async function pruneMembersFromWaitlist(): Promise<number> {
  const removed = await prisma.$executeRaw`
    DELETE FROM "Waitlist" w
    USING "User" u
    WHERE lower(w.email) = lower(u.email)
  `;
  return removed;
}

/** Remove a single email from the waitlist (used on register). Case-insensitive. */
export async function removeFromWaitlist(email: string): Promise<void> {
  await prisma.waitlist.deleteMany({ where: { email: { equals: email, mode: "insensitive" } } });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Admin manual/bulk invite: email a signup link to arbitrary addresses.
 * Skips addresses that already belong to a member, records each invited address
 * in the waitlist (source "admin-invite", invited=true) for tracking, and sends
 * with modest concurrency so large batches finish inside the request window.
 */
export async function inviteEmails(
  emailsIn: string[],
  code: string | undefined,
  source = "admin-invite",
): Promise<{
  code: string | undefined;
  sent: number;
  recipients: string[];
  skippedMembers: string[];
  invalid: string[];
  failed: { email: string; error: string }[];
}> {
  const normalized = [...new Set(emailsIn.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const invalid = normalized.filter((e) => !EMAIL_RE.test(e));
  const valid = normalized.filter((e) => EMAIL_RE.test(e));

  // Exclude anyone who already has an account (case-insensitive).
  const members = valid.length
    ? await prisma.user.findMany({
        where: { OR: valid.map((e) => ({ email: { equals: e, mode: "insensitive" as const } })) },
        select: { email: true },
      })
    : [];
  const memberSet = new Set(members.map((m) => m.email.toLowerCase()));
  const skippedMembers = valid.filter((e) => memberSet.has(e));
  const recipients = valid.filter((e) => !memberSet.has(e));

  const { subject, text, html } = buildWaitlistInvite(code);
  let sent = 0;
  const failed: { email: string; error: string }[] = [];

  // Concurrency-limited fan-out (chunks of 10) to stay well under the 120s limit.
  for (let i = 0; i < recipients.length; i += 10) {
    const chunk = recipients.slice(i, i + 10);
    await Promise.all(
      chunk.map(async (email) => {
        const res = await sendMail({ from: WAITLIST_INVITE_FROM, to: email, subject, text, html, tag: "admin-invite" });
        if (res.ok) {
          sent++;
          await prisma.waitlist
            .upsert({
              where: { email },
              update: { invited: true, source },
              create: { email, source, invited: true },
            })
            .catch(() => {});
        } else {
          failed.push({ email, error: res.error ?? "unknown" });
        }
      }),
    );
  }

  return { code, sent, recipients, skippedMembers, invalid, failed };
}

/** Flag specific emails as invited (no send) — e.g. after an out-of-band send. */
export async function markInvited(emails: string[]): Promise<number> {
  const list = emails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return 0;
  const res = await prisma.waitlist.updateMany({
    where: { email: { in: list } },
    data: { invited: true },
  });
  return res.count;
}

/** Admin: paginated list, newest first. Prunes now-registered members first. */
export async function listWaitlist(opts: { take?: number; skip?: number } = {}) {
  // Self-heal: never surface an email that already belongs to a member.
  await pruneMembersFromWaitlist().catch(() => {});
  const take = Math.min(Math.max(opts.take ?? 100, 1), 500);
  const skip = Math.max(opts.skip ?? 0, 0);
  const [total, entries] = await Promise.all([
    prisma.waitlist.count(),
    prisma.waitlist.findMany({
      orderBy: { createdAt: "desc" },
      take,
      skip,
      select: { id: true, email: true, source: true, referredBy: true, invited: true, createdAt: true },
    }),
  ]);
  return { total, entries };
}

/** Inspect a signup-invite code so we never mass-mail a link that can't be redeemed. */
export async function inspectInviteCode(code: string | undefined) {
  const inviteOnly = await getInviteOnly();
  const c = (code ?? "").trim();
  if (!c) return { inviteOnly, code: null as string | null, valid: !inviteOnly, reason: inviteOnly ? "no code provided" : "invite-only is off" };

  const row = await prisma.signupInvite.findUnique({ where: { code: c } });
  if (!row) return { inviteOnly, code: c, valid: false, reason: "code does not exist" };

  const now = new Date();
  const revoked = !!row.revokedAt;
  const expired = !!row.expiresAt && row.expiresAt <= now;
  const exhausted = row.maxUses > 0 && row.uses >= row.maxUses;
  const remaining = row.maxUses === 0 ? null : Math.max(0, row.maxUses - row.uses);
  const valid = !inviteOnly || (!revoked && !expired && !exhausted);
  const reason = !inviteOnly
    ? "invite-only is off (code optional)"
    : revoked ? "code revoked"
    : expired ? "code expired"
    : exhausted ? "code fully used"
    : "ok";

  return {
    inviteOnly,
    code: c,
    valid,
    reason,
    maxUses: row.maxUses,          // 0 = unlimited
    uses: row.uses,
    remaining,                     // null = unlimited
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

export interface SendInvitesOpts {
  invite?: string;   // signup-invite code embedded in the CTA link
  dryRun?: boolean;  // preview only — no email sent, nothing marked invited
  resend?: boolean;  // include rows already marked invited (default: only un-invited)
  limit?: number;    // cap how many to process this call (for batching)
}

/**
 * Send the "your spot opened" invite to the waitlist cohort.
 * Always prunes members first (requirement: no member ever gets a waitlist mail),
 * then processes un-invited rows oldest-first, marking each invited on success.
 */
export async function sendWaitlistInvites(opts: SendInvitesOpts = {}) {
  const prunedMembers = await pruneMembersFromWaitlist().catch(() => 0);
  const codeInfo = await inspectInviteCode(opts.invite);

  const take = Math.min(Math.max(opts.limit ?? 1000, 1), 5000);
  const recipients = await prisma.waitlist.findMany({
    where: opts.resend ? {} : { invited: false },
    orderBy: { createdAt: "asc" },
    take,
    select: { id: true, email: true },
  });

  if (opts.dryRun) {
    return {
      dryRun: true,
      inviteCode: codeInfo,
      prunedMembers,
      recipientCount: recipients.length,
      sample: recipients.slice(0, 15).map((r) => r.email),
      ctaUrl: waitlistInviteCtaUrl(opts.invite),
    };
  }

  const { subject, text, html } = buildWaitlistInvite(opts.invite);
  let sent = 0;
  const failed: { email: string; error: string }[] = [];

  for (const r of recipients) {
    const res = await sendMail({ from: WAITLIST_INVITE_FROM, to: r.email, subject, text, html, tag: "waitlist-invite" });
    if (res.ok) {
      sent++;
      await prisma.waitlist.update({ where: { id: r.id }, data: { invited: true } }).catch(() => {});
    } else {
      failed.push({ email: r.email, error: res.error ?? "unknown" });
    }
  }

  return {
    dryRun: false,
    inviteCode: codeInfo,
    prunedMembers,
    attempted: recipients.length,
    sent,
    failedCount: failed.length,
    failed: failed.slice(0, 25),
    ctaUrl: waitlistInviteCtaUrl(opts.invite),
  };
}
