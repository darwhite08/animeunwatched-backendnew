/**
 * Waitlist "you're off the line — the door's open" invitation email.
 *
 * Single source of truth for the content so the standalone preview script
 * (scripts/send-waitlist-invite.ts) and the cohort-send endpoint
 * (POST /waitlist/send-invites) send a byte-identical message.
 */

const SITE = "https://kaiveron.com";

export function waitlistInviteCtaUrl(invite?: string): string {
  return invite
    ? `${SITE}/register?invite=${encodeURIComponent(invite)}`
    : `${SITE}/register`;
}

export function buildWaitlistInvite(invite?: string): { subject: string; text: string; html: string } {
  const ctaUrl = waitlistInviteCtaUrl(invite);

  const subject = "You're off the waitlist — the door's open";
  const preheader = "Your spot at Kaiveron just opened. Step inside.";

  const text = [
    "You're in.",
    "",
    "You joined the Kaiveron waitlist — and your spot just opened.",
    "",
    "The door's open. Create your account and step inside: track every series and chapter, join the dens, follow the people who actually finish what they start, and earn your standing among real fans.",
    "",
    `Claim your seat: ${ctaUrl}`,
    "",
    "Admission stays deliberately slow, so this won't stay open forever — come in while it's yours.",
    "",
    "See you inside,",
    "— The Kaiveron team",
    "",
    SITE,
  ].join("\n");

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"></head>
<body style="margin:0;padding:0;background:#0b0a0e;">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0a0e;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #ececec;">
      <!-- header band -->
      <tr><td style="background:#08070A;padding:34px 40px 30px;text-align:center;">
        <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:5px;color:#F7C879;text-transform:uppercase;">By invitation</div>
        <div style="margin-top:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:26px;font-weight:800;letter-spacing:7px;color:#F4F2EC;">KAIVERON</div>
        <div style="margin:18px auto 0;height:2px;width:54px;background:#F5A623;border-radius:2px;"></div>
      </td></tr>
      <!-- body -->
      <tr><td style="padding:42px 40px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#16140f;">
        <h1 style="margin:0;font-size:34px;line-height:1.1;font-weight:800;letter-spacing:-0.5px;color:#0c0b08;">You're in.</h1>
        <p style="margin:22px 0 0;font-size:15.5px;line-height:1.65;color:#3a3a3a;">You joined the Kaiveron waitlist — and your spot just opened.</p>
        <p style="margin:16px 0 0;font-size:15.5px;line-height:1.65;color:#3a3a3a;">The door's open. Create your account and step inside: track every series and chapter, join the dens, follow the people who actually finish what they start, and earn your standing among real fans.</p>
      </td></tr>
      <!-- CTA -->
      <tr><td style="padding:30px 40px 6px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td align="center">
          <a href="${ctaUrl}" style="display:inline-block;background:#F5A623;color:#0a0805;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:0.3px;text-decoration:none;padding:15px 36px;border-radius:6px;">Claim your seat &nbsp;&rarr;</a>
        </td></tr></table>
      </td></tr>
      <tr><td style="padding:18px 40px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        <p style="margin:0;font-size:13px;line-height:1.6;color:#8a8a8a;text-align:center;">Admission stays deliberately slow — this won't stay open forever. Come in while it's yours.</p>
        <p style="margin:26px 0 0;font-size:15px;line-height:1.6;color:#3a3a3a;">See you inside,<br><strong style="color:#16140f;">The Kaiveron team</strong></p>
      </td></tr>
      <!-- footer -->
      <tr><td style="background:#faf9f5;padding:22px 40px;border-top:1px solid #eee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;text-align:center;">
        <a href="${SITE}" style="font-size:12px;color:#9a8a6a;text-decoration:none;letter-spacing:1px;">kaiveron.com</a>
        <p style="margin:10px 0 0;font-size:11px;line-height:1.5;color:#b3b0a8;">You're receiving this because you joined the Kaiveron waitlist. If this wasn't you, simply ignore this email.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  return { subject, text, html };
}
