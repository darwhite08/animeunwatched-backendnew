import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock nodemailer BEFORE importing the lib so getTransporter sees our stub.
const verifyMock = vi.fn(async () => true);
const sendMailMock = vi.fn(async () => ({ messageId: "msg-1" }));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      verify:   verifyMock,
      sendMail: sendMailMock,
    })),
  },
}));

// We must reset env between tests because the module caches `transporter` and
// `configError` at module scope.
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();   // clears the cached transporter/configError
  process.env = { ...ORIGINAL_ENV };
  delete process.env.SMTP_HOST; delete process.env.SMTP_PORT;
  delete process.env.SMTP_USER; delete process.env.SMTP_PASS;
  delete process.env.SMTP_FROM; delete process.env.SMTP_SECURE;
  verifyMock.mockClear();
  sendMailMock.mockClear();
});

afterEach(() => { process.env = { ...ORIGINAL_ENV } });

describe("mailer", () => {
  it("dry-run when SMTP_HOST not set", async () => {
    const { sendMail, mailerConfigured, mailerStatus } = await import("../app/src/lib/mailer");
    expect(mailerConfigured()).toBe(false);
    const r = await sendMail({ to: "x@y", subject: "hi", text: "hello" });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(mailerStatus().error).toMatch(/not set/);
  });

  it("dry-run when host set but user/pass missing", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    const { sendMail, mailerConfigured } = await import("../app/src/lib/mailer");
    expect(mailerConfigured()).toBe(false);
    const r = await sendMail({ to: "x@y", subject: "hi", text: "x" });
    expect(r.dryRun).toBe(true);
  });

  it("real send when fully configured", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "u";
    process.env.SMTP_PASS = "p";
    process.env.SMTP_FROM = "ops@kaiveron.com";
    const { sendMail, mailerConfigured, mailerStatus } = await import("../app/src/lib/mailer");
    expect(mailerConfigured()).toBe(true);
    expect(mailerStatus().from).toBe("ops@kaiveron.com");

    const r = await sendMail({ to: "x@y", subject: "hi", text: "hello", tag: "test" });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(false);
    expect(r.messageId).toBe("msg-1");
    expect(sendMailMock).toHaveBeenCalledOnce();
    const call = sendMailMock.mock.calls[0][0] as { from: string; to: string; subject: string };
    expect(call.from).toBe("ops@kaiveron.com");
    expect(call.to).toBe("x@y");
  });

  it("array recipients join with comma", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "u"; process.env.SMTP_PASS = "p";
    const { sendMail } = await import("../app/src/lib/mailer");
    await sendMail({ to: ["a@x", "b@x"], subject: "x", text: "y" });
    const call = sendMailMock.mock.calls[0][0] as { to: string };
    expect(call.to).toBe("a@x, b@x");
  });

  it("attachments are forwarded", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "u"; process.env.SMTP_PASS = "p";
    const { sendMail } = await import("../app/src/lib/mailer");
    await sendMail({
      to: "x@y", subject: "x", text: "y",
      attachments: [{ filename: "report.csv", content: "a,b\n1,2", contentType: "text/csv" }],
    });
    const call = sendMailMock.mock.calls[0][0] as { attachments: Array<{ filename: string }> };
    expect(call.attachments).toHaveLength(1);
    expect(call.attachments[0].filename).toBe("report.csv");
  });

  it("send failure returns ok:false with error", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "u"; process.env.SMTP_PASS = "p";
    sendMailMock.mockRejectedValueOnce(new Error("auth failed"));
    const { sendMail } = await import("../app/src/lib/mailer");
    const r = await sendMail({ to: "x@y", subject: "x", text: "y" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("auth failed");
  });

  it("probeMailer returns not_configured when missing env", async () => {
    const { probeMailer } = await import("../app/src/lib/mailer");
    const r = await probeMailer();
    expect(r.status).toBe("not_configured");
  });

  it("probeMailer returns ok when transporter.verify succeeds", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "u"; process.env.SMTP_PASS = "p";
    const { probeMailer } = await import("../app/src/lib/mailer");
    const r = await probeMailer();
    expect(r.status).toBe("ok");
    expect(verifyMock).toHaveBeenCalled();
  });

  it("probeMailer returns down when verify throws", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "u"; process.env.SMTP_PASS = "p";
    verifyMock.mockRejectedValueOnce(new Error("connection refused"));
    const { probeMailer } = await import("../app/src/lib/mailer");
    const r = await probeMailer();
    expect(r.status).toBe("down");
    expect(r.detail).toMatch(/connection refused/);
  });
});
