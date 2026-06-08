import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { rateLimit } from "../../middlewares/rateLimit.middleware";
import * as ctrl from "./groups.controller";

export const groupsRouter = Router();

const limitSendMin = rateLimit(30, 60_000, { perUser: true, bucket: "group-send-min" });
const limitSendDay = rateLimit(1000, 24 * 60 * 60_000, { perUser: true, bucket: "group-send-day" });
const limitCreate  = rateLimit(10, 60 * 60_000, { perUser: true, bucket: "group-create-hr" });
const limitReact   = rateLimit(60, 60_000, { perUser: true, bucket: "group-react" });

// Inbox
groupsRouter.get("/",             requireAuth, ctrl.list);
groupsRouter.post("/",            requireAuth, limitCreate, ctrl.create);
groupsRouter.get("/unread-count", requireAuth, ctrl.unread);

// Single group
groupsRouter.get("/:groupId",         requireAuth, ctrl.get);
groupsRouter.patch("/:groupId",       requireAuth, ctrl.update);
groupsRouter.get("/:groupId/devices", requireAuth, ctrl.devices);
groupsRouter.post("/:groupId/leave",  requireAuth, ctrl.leave);
groupsRouter.post("/:groupId/mute",   requireAuth, ctrl.mute);
groupsRouter.post("/:groupId/pin",    requireAuth, ctrl.pin);
groupsRouter.post("/:groupId/archive", requireAuth, ctrl.archive);

// Members
groupsRouter.post("/:groupId/members",            requireAuth, ctrl.addMembers);
groupsRouter.delete("/:groupId/members/:userId",  requireAuth, ctrl.removeMember);
groupsRouter.put("/:groupId/members/:userId/role", requireAuth, ctrl.setRole);

// Messages
groupsRouter.get("/:groupId/messages",  requireAuth, ctrl.messages);
groupsRouter.post("/:groupId/messages", requireAuth, limitSendMin, limitSendDay, ctrl.send);
groupsRouter.patch("/:groupId/read",    requireAuth, ctrl.markRead);
groupsRouter.patch("/:groupId/messages/:messageId",  requireAuth, ctrl.editMessage);
groupsRouter.delete("/:groupId/messages/:messageId", requireAuth, ctrl.deleteMessage);
groupsRouter.put("/:groupId/messages/:messageId/reaction", requireAuth, limitReact, ctrl.react);
