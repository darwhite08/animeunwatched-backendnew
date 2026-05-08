import { Router } from "express";
import { optionalAuth } from "../../middlewares/auth.middleware";
import { search } from "./search.controller";

export const searchRouter = Router();

searchRouter.get("/", optionalAuth, search);
