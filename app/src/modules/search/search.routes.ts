import { Router } from "express";
import { optionalAuth } from "../../middlewares/auth.middleware";
import { search, suggestions } from "./search.controller";

export const searchRouter = Router();

searchRouter.get("/suggestions", optionalAuth, suggestions);
searchRouter.get("/", optionalAuth, search);
