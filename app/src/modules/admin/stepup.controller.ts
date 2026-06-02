import type { Request, Response, NextFunction } from "express";
import argon2 from "argon2";
import { prisma } from "../../config/prisma";
import { badReq, forbidden } from "../../lib/errors";
import { verifyTotp, hashBackupCode } from "../../lib/totp";
import { issueStepUpToken } from "../../lib/stepup";
import { adminAudit, ipFromReq, uaFromReq } from "../../lib/adminAudit";

/**
 * Issue a step-up token after the user re-authenticates. The token is short-
 * lived (5 min), single-use, and scoped to one `purpose` (e.g. "users:role").
 *
 * Request requires the user's current password AND a TOTP code (if MFA is
 * enabled). If MFA is enrolled the code is mandatory; if not, password alone
 * is acceptable (but we strongly recommend operators enable MFA).
 */
export async function requestStepUp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = res.locals.user?.id as string;
    const { password, totp, purpose } = req.body as {
      password?: string; totp?: string; purpose?: string;
    };
    if (!password) throw badReq("password required");
    if (!purpose)  throw badReq("purpose required");

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw forbidden("User not found");

    const passOk = await argon2.verify(user.passwordHash, password);
    if (!passOk) {
      await adminAudit({
        actorId: userId, action: "stepup.failed", metadata: { purpose, reason: "bad_password" },
        ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
      });
      throw forbidden("Invalid password");
    }

    const totpRow = await prisma.totpSecret.findUnique({ where: { userId } });
    if (totpRow?.enabled) {
      if (!totp) throw badReq("totp code required");
      let totpOk = verifyTotp(totpRow.secretBase32, totp);
      if (!totpOk && Array.isArray(totpRow.backupCodes)) {
        const hash = hashBackupCode(totp);
        const codes = totpRow.backupCodes as string[];
        if (codes.includes(hash)) {
          totpOk = true;
          await prisma.totpSecret.update({
            where: { userId },
            data:  { backupCodes: codes.filter(c => c !== hash) as never },
          });
        }
      }
      if (!totpOk) {
        await adminAudit({
          actorId: userId, action: "stepup.failed", metadata: { purpose, reason: "bad_totp" },
          ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
        });
        throw forbidden("Invalid TOTP code");
      }
    }

    const token = await issueStepUpToken(userId, purpose);
    await adminAudit({
      actorId: userId, action: "stepup.issued", metadata: { purpose },
      ipAddress: ipFromReq(req), userAgent: uaFromReq(req),
    });
    res.status(200).json({ token, purpose, expiresInSec: 300 });
  } catch (err) { next(err); }
}
