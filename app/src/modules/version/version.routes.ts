import { Router } from "express";
import * as ctrl from "./version.controller";

export const versionRouter = Router();

versionRouter.get("/", ctrl.get);
