import { Router } from "express"
import * as ctrl from "./unsubscribe.controller"

// Public (no auth) — the token is the credential. GET is the human/mailto
// fallback; POST is the RFC 8058 one-click target named in List-Unsubscribe-Post.
export const unsubscribeRouter = Router()

unsubscribeRouter.get("/", ctrl.landing)
unsubscribeRouter.post("/", ctrl.oneClick)
