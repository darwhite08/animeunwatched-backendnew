import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./push.controller";

export const pushRouter = Router();

pushRouter.post("/register", requireAuth, ctrl.register);
pushRouter.delete("/register", requireAuth, ctrl.unregister);
// Native (Capacitor FCM/APNs) tokens — used by the mobile app
pushRouter.post("/native-token", requireAuth, ctrl.registerNative);
pushRouter.delete("/native-token", requireAuth, ctrl.unregisterNative);
pushRouter.get("/devices", requireAuth, ctrl.list);
pushRouter.post("/test", requireAuth, ctrl.test);
// CRON_SECRET-gated broadcast push campaign (targets an email or all Android users)
pushRouter.post("/campaign", ctrl.campaign);
// Web Push (VAPID) — browser/PWA subscriptions
pushRouter.post("/web/subscribe", requireAuth, ctrl.webSubscribe);
pushRouter.delete("/web/subscribe", requireAuth, ctrl.webUnsubscribe);
