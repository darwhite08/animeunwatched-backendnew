import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import * as ctrl from "./chat.controller";

export const chatRouter = Router();

// ─── Public key exchange (E2E encryption handshake) ───────────────────────────
chatRouter.put( "/keys/me",        requireAuth, ctrl.uploadPublicKey);
// Multi-device E2E (Phase 1, additive — old single-key routes stay for back-compat).
// Register a per-device key (append, never overwrite) and list a user's devices.
chatRouter.post("/keys/devices",          requireAuth, ctrl.registerDeviceKey);
chatRouter.get( "/keys/:userId/devices",  requireAuth, ctrl.getDeviceKeys);
chatRouter.get( "/keys/:userId",   requireAuth, ctrl.getPublicKey);

// ─── Conversations ────────────────────────────────────────────────────────────
chatRouter.get( "/conversations",                    requireAuth, ctrl.listConversations);
chatRouter.post("/conversations",                    requireAuth, ctrl.startConversation);
chatRouter.get( "/conversations/:conversationId",    requireAuth, ctrl.getConversation);

// ─── Messages ─────────────────────────────────────────────────────────────────
chatRouter.get( "/conversations/:conversationId/messages", requireAuth, ctrl.getMessages);
chatRouter.post("/conversations/:conversationId/messages", requireAuth, ctrl.sendMessage);
chatRouter.patch("/conversations/:conversationId/read",    requireAuth, ctrl.markRead);
// Delete a message — scope=me (hide from self) or scope=everyone (sender-only, within 24h)
chatRouter.delete("/conversations/:conversationId/messages/:messageId", requireAuth, ctrl.deleteMessage);
