import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./creator.controller";

export const creatorRouter = Router();

creatorRouter.use(requireAuth);

creatorRouter.get("/access",  ctrl.getAccess);   // can this user enter the Creator Studio?
creatorRouter.get("/blogs",   ctrl.getMyBlogs);  // my blogs incl. drafts (studio)
creatorRouter.get("/posts",   ctrl.getMyPosts);  // my feed posts + engagement (studio)
creatorRouter.get("/inbox",   ctrl.getEngagementInbox); // community: comments/replies/follows
creatorRouter.get("/level",   ctrl.getCreatorLevel);   // gamified creator tier + verified status
creatorRouter.get("/reviews", ctrl.getMyReviews);  // my anime reviews (studio)
creatorRouter.get("/clubs",   ctrl.getMyClubs);    // clubs I own (studio)
creatorRouter.get("/polls",   ctrl.getMyPolls);  // my polls incl. tallies (studio)
creatorRouter.get("/stats",   ctrl.getCreatorStats);
creatorRouter.get("/content", ctrl.getContentPerformance);
creatorRouter.get("/daily",   ctrl.getDailySeries);

// Creator Studio analytics (real metrics aggregated from engagement data)
creatorRouter.get("/analytics/overview", ctrl.getAnalyticsOverview);
creatorRouter.get("/analytics/content",  ctrl.getAnalyticsContent);
creatorRouter.get("/analytics/audience", ctrl.getAnalyticsAudience);
creatorRouter.get("/analytics/insights", ctrl.getAnalyticsInsights);
creatorRouter.get("/analytics/realtime", ctrl.getAnalyticsRealtime);
creatorRouter.get("/ideas",              ctrl.getContentIdeas);  // inspiration from trending engine
