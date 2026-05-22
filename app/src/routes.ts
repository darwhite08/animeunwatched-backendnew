import { Router } from "express";
import { authRouter } from "./modules/auth/auth.routes";
import { animeRouter } from "./modules/anime/anime.routes";
import { usersRouter } from "./modules/users/users.routes";
import { listsRouter } from "./modules/lists/lists.routes";
import { postsRouter } from "./modules/posts/posts.routes";
import { notificationsRouter } from "./modules/notifications/notifications.routes";
import { reviewsRouter, reviewsAnimeRouter } from "./modules/reviews/reviews.routes";
import { blogsRouter } from "./modules/blogs/blogs.routes";
import { searchRouter } from "./modules/search/search.routes";
import { clubsRouter } from "./modules/clubs/clubs.routes";
import { threadsRouter, animeThreadsRouter } from "./modules/threads/threads.routes";
import { adminRouter } from "./modules/admin/admin.routes";
import { creatorRouter } from "./modules/creator/creator.routes";
import { pollsRouter } from "./modules/polls/polls.routes";
import { analyticsRouter } from "./modules/analytics/analytics.routes";
import { webhooksRouter } from "./modules/webhooks/webhooks.routes";
import { chatRouter } from "./modules/chat/chat.routes";
import { pushRouter } from "./modules/push/push.routes";
import { uploadsRouter } from "./modules/uploads/uploads.routes";
import { discoveryRouter } from "./modules/discovery/discovery.routes";
import { aiRouter } from "./modules/ai/ai.routes";

const router = Router();

router.use("/auth", authRouter);
router.use("/anime", animeRouter);
router.use("/anime/:animeId/reviews", reviewsAnimeRouter);   // GET /anime/:animeId/reviews
router.use("/anime/:malId/threads", animeThreadsRouter); // POST /anime/:malId/threads
router.use("/users", usersRouter);
router.use("/lists", listsRouter);
router.use("/posts", postsRouter);
router.use("/notifications", notificationsRouter);
router.use("/reviews", reviewsRouter);
router.use("/blogs", blogsRouter);
router.use("/search", searchRouter);
router.use("/clubs", clubsRouter);
router.use("/threads", threadsRouter);
router.use("/admin", adminRouter);
router.use("/creator", creatorRouter);
router.use("/polls", pollsRouter);
router.use("/analytics", analyticsRouter);
router.use("/webhooks", webhooksRouter);
router.use("/chat",     chatRouter);
router.use("/push", pushRouter);
router.use("/uploads", uploadsRouter);
router.use("/discovery", discoveryRouter);
router.use("/ai", aiRouter);

export default router;
