import { Router } from "express";
import { animeRouter } from "../modules/anime/anime.routes";
import { authRouter } from "../modules/auth/auth.routes";
import { listsRouter } from "../modules/lists/lists.routes";
import { postsRouter } from "../modules/posts/posts.routes";
import { usersRouter } from "../modules/users/users.routes";

const router = Router();

router.use("/anime", animeRouter);
router.use("/auth", authRouter);
router.use("/lists", listsRouter);
router.use("/posts", postsRouter);
router.use("/users", usersRouter);

export default router;
