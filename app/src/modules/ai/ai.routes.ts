import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./ai.controller";

export const aiRouter = Router();

aiRouter.post("/ask", requireAuth, ctrl.ask);
aiRouter.post("/write", requireAuth, ctrl.write);
