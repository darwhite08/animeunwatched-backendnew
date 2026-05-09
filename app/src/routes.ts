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

const router = Router();

router.use("/auth", authRouter);
router.use("/anime", animeRouter);
router.use("/anime", reviewsAnimeRouter);   // mounts GET /anime/:animeId/reviews
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

export default router;
