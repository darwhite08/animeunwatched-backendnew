/**
 * "Kaiveron is on Google Play" download-the-app promo email.
 * Shared by the /push/campaign endpoint's email channel.
 */

const SITE = "https://kaiveron.com";

export function buildAppPromoEmail(playUrl: string): { subject: string; text: string; html: string } {
  const subject = "Kaiveron is now on Google Play 📲";
  const preheader = "The app is live — download it on the Play Store.";

  const text = [
    "The Kaiveron app is live.",
    "",
    "Download it on Google Play for the full experience — faster, native, with notifications so you never miss a beat.",
    "",
    `Get it on Google Play: ${playUrl}`,
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
      <tr><td style="background:#08070A;padding:34px 40px 30px;text-align:center;">
        <div style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:5px;color:#F7C879;text-transform:uppercase;">Now on Google Play</div>
        <div style="margin-top:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:26px;font-weight:800;letter-spacing:7px;color:#F4F2EC;">KAIVERON</div>
        <div style="margin:18px auto 0;height:2px;width:54px;background:#F5A623;border-radius:2px;"></div>
      </td></tr>
      <tr><td style="padding:42px 40px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#16140f;">
        <h1 style="margin:0;font-size:32px;line-height:1.12;font-weight:800;letter-spacing:-0.5px;color:#0c0b08;">The app is live.</h1>
        <p style="margin:22px 0 0;font-size:15.5px;line-height:1.65;color:#3a3a3a;">Kaiveron is now on Google Play. Download it for the full experience — faster, native, and with notifications so you never miss a beat.</p>
      </td></tr>
      <tr><td style="padding:30px 40px 6px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td align="center">
          <a href="${playUrl}" style="display:inline-block;background:#F5A623;color:#0a0805;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:0.3px;text-decoration:none;padding:15px 36px;border-radius:6px;">Get it on Google Play &nbsp;&rarr;</a>
        </td></tr></table>
      </td></tr>
      <tr><td style="padding:18px 40px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        <p style="margin:26px 0 0;font-size:15px;line-height:1.6;color:#3a3a3a;">See you inside,<br><strong style="color:#16140f;">The Kaiveron team</strong></p>
      </td></tr>
      <tr><td style="background:#faf9f5;padding:22px 40px;border-top:1px solid #eee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;text-align:center;">
        <a href="${SITE}" style="font-size:12px;color:#9a8a6a;text-decoration:none;letter-spacing:1px;">kaiveron.com</a>
        <p style="margin:10px 0 0;font-size:11px;line-height:1.5;color:#b3b0a8;">You're receiving this because you have a Kaiveron account.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  return { subject, text, html };
}
