import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

/**
 * Single low-level delivery path for ALL outbound mail (both lib/mailer.ts and
 * lib/email.ts route through here).
 *
 * Prefers Resend's HTTPS API (https://api.resend.com/emails, port 443) over SMTP.
 * Reason: App Runner's VPC egress cannot reach smtp.resend.com:465 (SMTP times
 * out with "Greeting never received"), but 443 works fine. Resend's SMTP password
 * IS the API key, so we reuse SMTP_PASS — no new secret required. Falls back to
 * plain SMTP only when no Resend key is present (e.g. a classic mailbox setup).
 */

export interface DeliverAttachment {
  filename: string;
  content: string | Buffer;
  contentType?: string;
}

export interface DeliverArgs {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: DeliverAttachment[];
}

export interface DeliverResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  via: "resend-api" | "smtp" | "none";
}

function resendApiKey(): string | null {
  if (process.env.RESEND_API_KEY) return process.env.RESEND_API_KEY;
  // Resend's SMTP username is literally "resend" and its password is the API key.
  // Reuse that key for the HTTP API so no extra env var is needed.
  const host = (process.env.SMTP_HOST ?? "").toLowerCase();
  if (host.includes("resend") && process.env.SMTP_PASS) return process.env.SMTP_PASS;
  return null;
}

/** True when any real transport (Resend API or SMTP) is available. */
export function emailTransportConfigured(): boolean {
  return !!resendApiKey() || (!!process.env.SMTP_HOST && !!process.env.SMTP_USER && !!process.env.SMTP_PASS);
}

async function deliverViaResend(key: string, args: DeliverArgs): Promise<DeliverResult> {
  const to = Array.isArray(args.to) ? args.to : [args.to];
  const body: Record<string, unknown> = { from: args.from, to, subject: args.subject };
  if (args.html) body.html = args.html;
  if (args.text) body.text = args.text;
  if (args.headers) body.headers = args.headers;
  if (args.attachments?.length) {
    body.attachments = args.attachments.map((a) => ({
      filename: a.filename,
      content: (Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content)).toString("base64"),
    }));
  }
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await resp.json().catch(() => ({}))) as { id?: string; message?: string; name?: string; error?: { message?: string } };
    if (!resp.ok) {
      const msg = data.message || data.error?.message || data.name || `HTTP ${resp.status}`;
      return { ok: false, error: String(msg), via: "resend-api" };
    }
    return { ok: true, messageId: data.id, via: "resend-api" };
  } catch (err) {
    return { ok: false, error: (err as Error).message, via: "resend-api" };
  }
}

let _smtp: Transporter | null = null;
function smtpTransport(): Transporter | null {
  if (_smtp) return _smtp;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  const port = Number(process.env.SMTP_PORT ?? 587);
  _smtp = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return _smtp;
}

async function deliverViaSmtp(args: DeliverArgs): Promise<DeliverResult> {
  const t = smtpTransport();
  if (!t) return { ok: false, error: "no transport configured", via: "none" };
  try {
    const info = await t.sendMail({
      from: args.from,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
      headers: args.headers,
      attachments: args.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    return { ok: true, messageId: info.messageId, via: "smtp" };
  } catch (err) {
    return { ok: false, error: (err as Error).message, via: "smtp" };
  }
}

export async function deliverEmail(args: DeliverArgs): Promise<DeliverResult> {
  const key = resendApiKey();
  // When a Resend key exists, use the API exclusively — SMTP is the known-broken
  // path on App Runner, so falling back to it would just hang for 120s.
  if (key) return deliverViaResend(key, args);
  return deliverViaSmtp(args);
}

/** Best-effort connectivity probe for health checks. */
export async function probeEmailTransport(): Promise<{ status: "ok" | "down" | "not_configured"; via?: string; detail?: string }> {
  const key = resendApiKey();
  if (key) {
    try {
      const resp = await Promise.race([
        fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${key}` } }),
        new Promise<Response>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3_000)),
      ]);
      return resp.ok ? { status: "ok", via: "resend-api" } : { status: "down", via: "resend-api", detail: `HTTP ${resp.status}` };
    } catch (err) {
      return { status: "down", via: "resend-api", detail: (err as Error).message };
    }
  }
  const t = smtpTransport();
  if (!t) return { status: "not_configured" };
  try {
    const ok = await Promise.race([
      t.verify(),
      new Promise<boolean>((_, rej) => setTimeout(() => rej(new Error("verify timeout")), 3_000)),
    ]);
    return ok ? { status: "ok", via: "smtp" } : { status: "down", via: "smtp" };
  } catch (err) {
    return { status: "down", via: "smtp", detail: (err as Error).message };
  }
}
