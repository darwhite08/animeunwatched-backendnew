import { z } from "zod";

const b64 = z.string().min(1).max(8192);
const wrap = z.object({
  method: z.enum(["PASSKEY_PRF", "RECOVERY_CODE", "FALLBACK_PASSPHRASE"]),
  credentialId: z.string().max(512).optional(),
  wrappedUMK: b64,
  wrapIv: b64,
  kdfSalt: b64.optional(),
  kdfParams: z.any().optional(),
  label: z.string().max(80).optional(),
});
const device = z.object({
  publicKey: b64,
  wrappedPrivKey: b64,
  wrapIv: b64,
  name: z.string().min(1).max(80),
});

export const setupSchema = z.object({ body: z.object({ wraps: z.array(wrap).min(1).max(10), device }) });
export const addDeviceSchema = z.object({ body: device });
export const addWrapSchema = z.object({ body: wrap });
export const healSchema = z.object({
  body: z.object({
    items: z.array(z.object({
      messageId: z.string().min(1), deviceId: z.string().min(1),
      ephemeralPub: b64, wrappedCK: b64, wrapIv: b64,
    })).min(1).max(200),
  }),
});
