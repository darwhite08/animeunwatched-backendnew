/**
 * Waitlist "your spot opened" invitation email.
 *
 * Single source of truth for the content so the admin bulk-invite
 * (POST /admin/signup-access/invite) and the cohort-send endpoint
 * (POST /waitlist/send-invites) send a byte-identical message.
 *
 * Deliberately plain + personal (no logo band, no CTA button, no hidden
 * preheader, no marketing footer) and sent from a personal display name — the
 * branded/marketing version reliably landed in Gmail's Promotions tab. A short
 * text-forward note from a person is what Gmail treats as Primary/transactional.
 */

const SITE = "https://kaiveron.com";

// Personal From so it reads as a 1:1 note, not a broadcast. Address stays on the
// verified kaiveron.com domain (Resend verifies the domain, not the mailbox).
export const WAITLIST_INVITE_FROM = "Priyanshu at Kaiveron <no-reply@kaiveron.com>";

export function waitlistInviteCtaUrl(invite?: string): string {
  return invite
    ? `${SITE}/register?invite=${encodeURIComponent(invite)}`
    : `${SITE}/register`;
}

export function buildWaitlistInvite(invite?: string): { subject: string; text: string; html: string } {
  const ctaUrl = waitlistInviteCtaUrl(invite);

  const subject = "Your Kaiveron invite";

  const text = [
    "Hey — you joined the Kaiveron waitlist a while back, and your spot just opened.",
    "",
    "Here's your link to set up your account:",
    ctaUrl,
    "",
    "It's invite-only and slots are limited, so grab it while it's yours.",
    "",
    "— Priyanshu, Kaiveron",
  ].join("\n");

  // Minimal HTML that mirrors the text 1:1 — plain paragraphs, one normal link,
  // no images/buttons/branding. Renders like a personal email.
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;">
<p style="margin:0 0 16px;">Hey — you joined the Kaiveron waitlist a while back, and your spot just opened.</p>
<p style="margin:0 0 16px;">Here's your link to set up your account:<br>
<a href="${ctaUrl}" style="color:#1a56db;">${ctaUrl}</a></p>
<p style="margin:0 0 16px;">It's invite-only and slots are limited, so grab it while it's yours.</p>
<p style="margin:0;">— Priyanshu, Kaiveron</p>
</div>`;

  return { subject, text, html };
}
