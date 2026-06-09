import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { rateLimit } from "../../middlewares/rateLimit.middleware";
import * as ctrl from "./safety.controller";

// User-scoped block + report endpoints. Mounted at /users and /reports.
export const blockRouter = Router();
blockRouter.get("/blocked", requireAuth, ctrl.listBlocked);
blockRouter.post("/:id/block", requireAuth, ctrl.blockUser);
blockRouter.delete("/:id/block", requireAuth, ctrl.unblockUser);

export const reportsRouter = Router();
// reports 10/day per user (spec §3)
reportsRouter.post("/", requireAuth, rateLimit(10, 24 * 60 * 60_000, { perUser: true, bucket: "dm-report" }), ctrl.report);
// Generic content report (user/post/shot/comment/thread/club/review)
reportsRouter.post("/content", requireAuth, rateLimit(20, 24 * 60 * 60_000, { perUser: true, bucket: "content-report" }), ctrl.reportContent);
