import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./chat.controller";

export const chatRouter = Router();

// ─── Public key exchange (E2E encryption handshake) ───────────────────────────
chatRouter.put( "/keys/me",        requireAuth, ctrl.uploadPublicKey);
chatRouter.get( "/keys/:userId",   requireAuth, ctrl.getPublicKey);

// ─── Conversations ────────────────────────────────────────────────────────────
chatRouter.get( "/conversations",                    requireAuth, ctrl.listConversations);
chatRouter.post("/conversations",                    requireAuth, ctrl.startConversation);
chatRouter.get( "/conversations/:conversationId",    requireAuth, ctrl.getConversation);

// ─── Messages ─────────────────────────────────────────────────────────────────
chatRouter.get( "/conversations/:conversationId/messages", requireAuth, ctrl.getMessages);
chatRouter.post("/conversations/:conversationId/messages", requireAuth, ctrl.sendMessage);
chatRouter.patch("/conversations/:conversationId/read",    requireAuth, ctrl.markRead);
