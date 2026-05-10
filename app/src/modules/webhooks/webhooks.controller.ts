import { Request, Response, NextFunction } from "express";
import * as webhooksService from "./webhooks.service";

export async function testWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = res.locals.user?.id ?? "test-user";
    const payload = webhooksService.buildTestPayload("user.registered", userId, { test: true });
    await webhooksService.fireWebhook("user.registered", userId, { test: true });
    res.json({ ok: true, payload });
  } catch (err) {
    next(err);
  }
}
