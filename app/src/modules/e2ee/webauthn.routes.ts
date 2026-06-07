import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as wa from "./webauthn.service";

export const webauthnRouter = Router();

webauthnRouter.post("/register/options", requireAuth, async (req, res, next) => {
  try { res.json(await wa.registrationOptions(res.locals.user.id, res.locals.user.username ?? res.locals.user.id)); } catch (e) { next(e); }
});
webauthnRouter.post("/register/verify", requireAuth, async (req, res, next) => {
  try { res.json(await wa.verifyRegistration(res.locals.user.id, req.body?.response)); } catch (e) { next(e); }
});
webauthnRouter.post("/auth/options", requireAuth, async (req, res, next) => {
  try { res.json(await wa.authenticationOptions(res.locals.user.id)); } catch (e) { next(e); }
});
webauthnRouter.post("/auth/verify", requireAuth, async (req, res, next) => {
  try { res.json(await wa.verifyAuthentication(res.locals.user.id, req.body?.response)); } catch (e) { next(e); }
});
