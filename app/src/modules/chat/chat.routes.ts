import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { rateLimit } from "../../middlewares/rateLimit.middleware";
import * as ctrl from "./chat.controller";

export const chatRouter = Router();

// ─── DM v2 rate limits (per authenticated user) ───────────────────────────────
const limitSendMin   = rateLimit(30, 60_000,         { perUser: true, bucket: "dm-send-min" });
const limitSendDay   = rateLimit(500, 24 * 60 * 60_000, { perUser: true, bucket: "dm-send-day" });
const limitNewConvHr = rateLimit(5, 60 * 60_000,     { perUser: true, bucket: "dm-newconv-hr" });
const limitNewConvDy = rateLimit(20, 24 * 60 * 60_000, { perUser: true, bucket: "dm-newconv-day" });
const limitReactions = rateLimit(60, 60_000,         { perUser: true, bucket: "dm-react" });

// ─── Public key exchange (legacy E2E handshake — kept for back-compat) ─────────
chatRouter.put( "/keys/me",        requireAuth, ctrl.uploadPublicKey);
chatRouter.post("/keys/devices",          requireAuth, ctrl.registerDeviceKey);
chatRouter.get( "/keys/:userId/devices",  requireAuth, ctrl.getDeviceKeys);
chatRouter.get( "/keys/:userId",   requireAuth, ctrl.getPublicKey);

// ─── Conversations ────────────────────────────────────────────────────────────
chatRouter.get( "/conversations", requireAuth, ctrl.listConversations);
// New-conversation anti-spam: the single most important limit (spec §3).
chatRouter.post("/conversations", requireAuth, limitNewConvHr, limitNewConvDy, ctrl.startConversation);
chatRouter.get( "/unread-count",  requireAuth, ctrl.unreadCount);
chatRouter.get( "/conversations/:conversationId", requireAuth, ctrl.getConversation);
chatRouter.post("/conversations/:conversationId/accept",  requireAuth, ctrl.acceptRequest);
chatRouter.post("/conversations/:conversationId/decline", requireAuth, ctrl.declineRequest);
chatRouter.post("/conversations/:conversationId/mute",    requireAuth, ctrl.muteConversation);
chatRouter.delete("/conversations/:conversationId",       requireAuth, ctrl.deleteConversation);
chatRouter.get( "/conversations/:conversationId/search",  requireAuth, ctrl.searchConversation);

// ─── Messages ─────────────────────────────────────────────────────────────────
chatRouter.get( "/conversations/:conversationId/messages", requireAuth, ctrl.getMessages);
chatRouter.post("/conversations/:conversationId/messages", requireAuth, limitSendMin, limitSendDay, ctrl.sendMessage);
chatRouter.patch("/conversations/:conversationId/read",    requireAuth, ctrl.markRead);
chatRouter.delete("/conversations/:conversationId/messages/:messageId", requireAuth, ctrl.deleteMessage);

// Inline reply from a system notification — authenticated by the reply token itself.
chatRouter.post("/push-reply", ctrl.pushReply);

// Message-level edit / delete / reaction (spec §3 paths)
chatRouter.patch( "/messages/:id",          requireAuth, ctrl.editMessage);
chatRouter.put(   "/messages/:id/reaction", requireAuth, limitReactions, ctrl.putReaction);
// Legacy reaction routes (mobile client still uses these until Stage 5)
chatRouter.post(  "/messages/:messageId/reactions", requireAuth, limitReactions, ctrl.addReaction);
chatRouter.delete("/messages/:messageId/reactions", requireAuth, ctrl.removeReaction);
