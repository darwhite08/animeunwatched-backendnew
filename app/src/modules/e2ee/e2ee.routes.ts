import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { rateLimit } from "../../middlewares/rateLimit.middleware";
import * as ctrl from "./e2ee.controller";

export const e2eeRouter = Router();

e2eeRouter.post("/setup",        requireAuth, rateLimit(10, 60 * 60_000, { perUser: true, bucket: "e2ee-setup" }), ctrl.setup);
e2eeRouter.get( "/state",        requireAuth, ctrl.state);
e2eeRouter.post("/devices",      requireAuth, rateLimit(20, 60 * 60_000, { perUser: true, bucket: "e2ee-device" }), ctrl.addDevice);
e2eeRouter.delete("/devices/:id", requireAuth, ctrl.revokeDevice);
e2eeRouter.post("/wraps",        requireAuth, rateLimit(20, 60 * 60_000, { perUser: true, bucket: "e2ee-wrap" }), ctrl.addWrap);
e2eeRouter.delete("/wraps/:id",  requireAuth, ctrl.removeWrap);
e2eeRouter.get( "/conversations/:id/devices", requireAuth, ctrl.conversationDevices);
e2eeRouter.post("/envelopes/heal", requireAuth, rateLimit(60, 60_000, { perUser: true, bucket: "e2ee-heal" }), ctrl.heal);
