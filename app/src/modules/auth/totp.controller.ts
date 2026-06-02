import type { Request, Response, NextFunction } from "express";
import argon2 from "argon2";
import { prisma } from "../../config/prisma";
import { generateSecretBase32, otpauthUrl, verifyTotp, generateBackupCodes, hashBackupCode } from "../../lib/totp";
import { badReq, forbidden } from "../../lib/errors";
import { recordSecurityEvent } from "../../lib/audit";

/**
 * Begin TOTP enrollment. Stores the secret as disabled; the user must verify
 * a code from their authenticator before enabled=true. Re-enrolling overwrites
 * any prior disabled secret.
 */
export async function setupTotp(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = res.locals.user?.id as string;
    const user   = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) throw forbidden("User not found");

    const existing = await prisma.totpSecret.findUnique({ where: { userId } });
    if (existing?.enabled) throw badReq("TOTP already enabled; disable first to re-enroll");

    const secretBase32 = generateSecretBase32();
    await prisma.totpSecret.upsert({
      where:  { userId },
      update: { secretBase32, enabled: false, backupCodes: undefined },
      create: { userId, secretBase32 },
    });
    res.status(200).json({
      secret:  secretBase32,
      otpauth: otpauthUrl({ issuer: "Kaiveron", account: user.email, secretBase32 }),
    });
  } catch (err) { next(err); }
}

/**
 * Confirm enrollment by submitting the first 6-digit code. Generates backup
 * codes on first verify (returned ONCE — never shown again).
 */
export async function verifyTotpEnroll(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = res.locals.user?.id as string;
    const { code } = req.body as { code?: string };
    if (!code) throw badReq("code required");
    const row = await prisma.totpSecret.findUnique({ where: { userId } });
    if (!row) throw badReq("no TOTP secret pending — call setup first");
    if (!verifyTotp(row.secretBase32, code)) throw badReq("invalid code");

    const backupCodes = generateBackupCodes();
    await prisma.totpSecret.update({
      where: { userId },
      data:  {
        enabled:     true,
        backupCodes: backupCodes.map(hashBackupCode) as never,
        lastUsedAt:  new Date(),
      },
    });
    recordSecurityEvent("password_changed", { userId, req, metadata: { mfa: "totp_enrolled" } });
    res.status(200).json({ enabled: true, backupCodes });
  } catch (err) { next(err); }
}

/**
 * Disable TOTP. Requires current password to prevent session-hijack-based
 * bypass. Wipes the secret entirely.
 */
export async function disableTotp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = res.locals.user?.id as string;
    const { password } = req.body as { password?: string };
    if (!password) throw badReq("password required");
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !(await argon2.verify(user.passwordHash, password))) {
      throw forbidden("Invalid password");
    }
    await prisma.totpSecret.deleteMany({ where: { userId } });
    recordSecurityEvent("password_changed", { userId, req, metadata: { mfa: "totp_disabled" } });
    res.status(200).json({ enabled: false });
  } catch (err) { next(err); }
}

/** Status check — does this user have TOTP enabled? */
export async function getTotpStatus(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = res.locals.user?.id as string;
    const row = await prisma.totpSecret.findUnique({ where: { userId }, select: { enabled: true } });
    res.status(200).json({ enabled: !!row?.enabled });
  } catch (err) { next(err); }
}
