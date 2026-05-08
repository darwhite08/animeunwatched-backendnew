import { Router } from "express";
import { authRouter } from "./modules/auth/auth.routes";
import { animeRouter } from "./modules/anime/anime.routes";
import { usersRouter } from "./modules/users/users.routes";
import { listsRouter } from "./modules/lists/lists.routes";
import { postsRouter } from "./modules/posts/posts.routes";

const router = Router();

router.use("/auth", authRouter);
router.use("/anime", animeRouter);
router.use("/users", usersRouter);
router.use("/lists", listsRouter);
router.use("/posts", postsRouter);

export default router;
