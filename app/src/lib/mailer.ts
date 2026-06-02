import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

/**
 * Provider-agnostic email sender. Uses nodemailer + SMTP. For AWS SES, set
 * the SES SMTP credentials (Region → SMTP Settings → "Create SMTP credentials")
 * — SES presents itself as a plain SMTP endpoint, so we don't need the SES SDK.
 *
 * Env:
 *   SMTP_HOST          required to enable real sends
 *   SMTP_PORT          default 587
 *   SMTP_USER          required when SMTP_HOST is set
 *   SMTP_PASS          required when SMTP_HOST is set
 *   SMTP_FROM          default "no-reply@kaiveron.com"
 *   SMTP_SECURE        "true" for port 465 implicit TLS; default false (STARTTLS)
 *
 * Without SMTP_HOST: every send is a no-op that logs "[mailer:dry-run] ..."
 * and returns { ok: true, dryRun: true }. Lets the rest of the app behave
 * identically in dev / on systems where SMTP isn't wired yet.
 */

let transporter: Transporter | null = null;
let configError: string | null = null;

function getTransporter(): Transporter | null {
  if (transporter) return transporter;
  if (configError) return null;
  if (!process.env.SMTP_HOST) {
    configError = "SMTP_HOST not set";
    return null;
  }
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    configError = "SMTP_USER / SMTP_PASS not set";
    return null;
  }
  try {
    transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === "true",
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    return transporter;
  } catch (err) {
    configError = (err as Error).message;
    console.error("[mailer] init failed:", err);
    return null;
  }
}

export function mailerConfigured(): boolean {
  return !!process.env.SMTP_HOST && !!process.env.SMTP_USER && !!process.env.SMTP_PASS;
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
    error:      mailerConfigured() ? null : configError,
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

  const t = getTransporter();
  if (!t) {
    console.log(`[mailer:dry-run:${tag}] would send to ${recipients} — "${args.subject}"${args.attachments ? ` (+${args.attachments.length} attachment)` : ""}`);
    return { ok: true, dryRun: true };
  }

  try {
    const info = await t.sendMail({
      from,
      to:          recipients,
      subject:     args.subject,
      text:        args.text,
      html:        args.html,
      attachments: args.attachments?.map(a => ({
        filename:    a.filename,
        content:     a.content,
        contentType: a.contentType,
      })),
    });
    console.log(`[mailer:${tag}] sent to ${recipients} — message-id ${info.messageId}`);
    return { ok: true, dryRun: false, messageId: info.messageId };
  } catch (err) {
    console.error(`[mailer:${tag}] send failed:`, err);
    return { ok: false, dryRun: false, error: (err as Error).message };
  }
}

/**
 * Best-effort SMTP connectivity probe. Used by /admin/health/dependencies.
 * Times out at 3s.
 */
export async function probeMailer(): Promise<{ status: "ok" | "down" | "not_configured"; detail?: string }> {
  if (!mailerConfigured()) return { status: "not_configured", detail: "SMTP_HOST / SMTP_USER / SMTP_PASS not set" };
  const t = getTransporter();
  if (!t) return { status: "down", detail: configError ?? "transporter unavailable" };
  try {
    const verified = await Promise.race([
      t.verify(),
      new Promise<boolean>((_, rej) => setTimeout(() => rej(new Error("verify timeout")), 3_000)),
    ]);
    return verified ? { status: "ok" } : { status: "down", detail: "verify returned false" };
  } catch (err) {
    return { status: "down", detail: (err as Error).message };
  }
}
