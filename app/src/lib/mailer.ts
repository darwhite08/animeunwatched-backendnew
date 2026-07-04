import { deliverEmail, emailTransportConfigured, probeEmailTransport } from "./deliver";

/**
 * Provider-agnostic email sender. Delegates the actual delivery to lib/deliver.ts,
 * which prefers Resend's HTTPS API (App Runner cannot reach SMTP:465) and falls
 * back to SMTP when no Resend key is present.
 *
 * Env:
 *   RESEND_API_KEY     Resend HTTP API key (optional — SMTP_PASS is reused when
 *                      SMTP_HOST is a Resend host, so this need not be set)
 *   SMTP_HOST          SMTP host (fallback path)
 *   SMTP_PORT          default 587
 *   SMTP_USER/PASS     SMTP creds (for Resend: user "resend", pass = API key)
 *   SMTP_FROM          default "no-reply@kaiveron.com"
 *   SMTP_SECURE        "true" for port 465 implicit TLS; default false (STARTTLS)
 *
 * Without any transport: every send is a no-op that logs "[mailer:dry-run] ..."
 * and returns { ok: true, dryRun: true }.
 */

export function mailerConfigured(): boolean {
  return emailTransportConfigured();
}

export function mailerStatus(): {
  configured: boolean;
  host:       string | null;
  from:       string;
  error:      string | null;
} {
  return {
    configured: mailerConfigured(),
    host:       process.env.SMTP_HOST ?? null,
    from:       process.env.SMTP_FROM ?? "no-reply@kaiveron.com",
    error:      mailerConfigured() ? null : "no email transport configured",
  };
}

export interface MailAttachment {
  filename:    string;
  content:     string | Buffer;
  contentType: string;
}

export interface SendMailArgs {
  to:          string | string[];
  subject:     string;
  text:        string;
  html?:       string;
  attachments?: MailAttachment[];
  /**
   * Optional override for the From: header. When unset uses SMTP_FROM env
   * (or no-reply@kaiveron.com). Used by transactional sends (e.g. invites)
   * that want a recognizable from address.
   */
  from?:       string;
  /**
   * Free-form tag for audit/observability. Logged with every send so we can
   * grep "[mailer:report]" to find a class of sends.
   */
  tag?:        string;
}

export interface SendMailResult {
  ok:         boolean;
  dryRun:     boolean;
  messageId?: string;
  error?:     string;
}

export async function sendMail(args: SendMailArgs): Promise<SendMailResult> {
  const from = args.from ?? process.env.SMTP_FROM ?? "no-reply@kaiveron.com";
  const tag  = args.tag ?? "default";
  const recipients = Array.isArray(args.to) ? args.to.join(", ") : args.to;

  if (!emailTransportConfigured()) {
    console.log(`[mailer:dry-run:${tag}] would send to ${recipients} — "${args.subject}"${args.attachments ? ` (+${args.attachments.length} attachment)` : ""}`);
    return { ok: true, dryRun: true };
  }

  const res = await deliverEmail({
    from,
    to:          args.to,
    subject:     args.subject,
    text:        args.text,
    html:        args.html,
    attachments: args.attachments,
  });
  if (res.ok) {
    console.log(`[mailer:${tag}] sent to ${recipients} via ${res.via} — message-id ${res.messageId}`);
    return { ok: true, dryRun: false, messageId: res.messageId };
  }
  console.error(`[mailer:${tag}] send failed via ${res.via}: ${res.error}`);
  return { ok: false, dryRun: false, error: res.error };
}

/**
 * Best-effort transport connectivity probe. Used by /admin/health/dependencies.
 * Times out at 3s.
 */
export async function probeMailer(): Promise<{ status: "ok" | "down" | "not_configured"; detail?: string }> {
  const r = await probeEmailTransport();
  return { status: r.status, detail: r.detail ?? r.via };
}
