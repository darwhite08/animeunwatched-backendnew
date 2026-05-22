import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./push.controller";

export const pushRouter = Router();

pushRouter.post("/register", requireAuth, ctrl.register);
pushRouter.delete("/register", requireAuth, ctrl.unregister);
pushRouter.get("/devices", requireAuth, ctrl.list);
pushRouter.post("/test", requireAuth, ctrl.test);
