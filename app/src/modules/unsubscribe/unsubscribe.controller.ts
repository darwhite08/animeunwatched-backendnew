import { Request, Response } from "express"
import { prisma } from "../../config/prisma"
import { verifyUnsubToken } from "../../lib/unsubscribe"

/** Apply the unsubscribe encoded in the token. Idempotent; never throws. */
async function applyToken(token: string): Promise<boolean> {
  const v = verifyUnsubToken(token)
  if (!v) return false
  try {
    if (v.scope === "msg") {
      await prisma.user.update({ where: { id: v.userId }, data: { emailOnNewMessage: false } })
    }
    return true
  } catch {
    return false // unknown user / DB hiccup — fail soft
  }
}

/**
 * RFC 8058 one-click unsubscribe. Mailbox providers POST here with body
 * `List-Unsubscribe=One-Click`; the token (recipient + category) is in the query.
 * Must be a plain POST, no redirect, fast 200.
 */
export async function oneClick(req: Request, res: Response): Promise<void> {
  await applyToken(String(req.query.token ?? ""))
  res.status(200).type("text/plain").send("Unsubscribed.")
}

/** Human-facing GET (mailto/link fallback) — confirms in a tiny styled page. */
export async function landing(req: Request, res: Response): Promise<void> {
  const ok = await applyToken(String(req.query.token ?? ""))
  const msg = ok
    ? "You've been unsubscribed from these emails. You can re-enable them anytime in Kaiveron → Settings → Notifications."
    : "This unsubscribe link is invalid or has expired. Manage your email preferences in Kaiveron → Settings → Notifications."
  res.status(200).type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kaiveron — Email preferences</title></head>
<body style="margin:0;background:#0a0a0a;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:520px;margin:12vh auto;padding:40px;text-align:center">
    <div style="font-size:22px;font-weight:900;font-style:italic;color:#f59e0b;margin-bottom:24px">Kaiveron</div>
    <h1 style="font-size:22px;font-weight:800;margin:0 0 12px">${ok ? "You're unsubscribed ✓" : "Link not valid"}</h1>
    <p style="color:#aaa;line-height:1.6;font-size:14px">${msg}</p>
    <a href="https://kaiveron.com/me/settings/notifications" style="display:inline-block;margin-top:24px;color:#f59e0b;text-decoration:none;font-weight:700;font-size:13px">Notification settings →</a>
  </div>
</body></html>`)
}
