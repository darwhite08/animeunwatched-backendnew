import { Request, Response, NextFunction } from "express";
import * as chatService from "./chat.service";
import {
  uploadPublicKeySchema,
  registerDeviceKeySchema,
  startConversationSchema,
  sendMessageSchema,
  getMessagesSchema,
} from "./chat.schema";

export async function uploadPublicKey(req: Request, res: Response, next: NextFunction) {
  try {
    const { body } = uploadPublicKeySchema.parse({ body: req.body });
    const userId   = res.locals.user.id as string;
    const result   = await chatService.upsertPublicKey(userId, body.publicKey);
    res.json({ publicKey: result });
  } catch (err) {
    next(err);
  }
}

export async function getPublicKey(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.params.userId as string;
    const result = await chatService.getPublicKey(userId);
    res.json({ publicKey: result.publicKey });
  } catch (err) {
    next(err);
  }
}

// ─── Multi-device keys (Phase 1, additive) ─────────────────────────────────────
export async function registerDeviceKey(req: Request, res: Response, next: NextFunction) {
  try {
    const { body } = registerDeviceKeySchema.parse({ body: req.body });
    const userId   = res.locals.user.id as string;
    const row      = await chatService.registerDeviceKey(userId, body.deviceId, body.publicKey);
    res.json({ deviceKey: { id: row.id, deviceId: row.deviceId, publicKey: row.publicKey } });
  } catch (err) {
    next(err);
  }
}

export async function getDeviceKeys(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.params.userId as string;
    const keys   = await chatService.getDeviceKeys(userId);
    res.json({ deviceKeys: keys });
  } catch (err) {
    next(err);
  }
}

export async function getConversation(req: Request, res: Response, next: NextFunction) {
  try {
    const conversationId = req.params.conversationId as string;
    const userId         = res.locals.user.id as string;
    const result         = await chatService.getConversationById(conversationId, userId);
    res.json({ conversation: result });
  } catch (err) {
    next(err);
  }
}

export async function startConversation(req: Request, res: Response, next: NextFunction) {
  try {
    const { body }  = startConversationSchema.parse({ body: req.body });
    const callerId  = res.locals.user.id as string;
    const result    = await chatService.getOrCreateConversation(callerId, body.recipientId);
    res.status(201).json({ conversation: result });
  } catch (err) {
    next(err);
  }
}

export async function listConversations(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = res.locals.user.id as string;
    const result = await chatService.listConversations(userId);
    res.json({ conversations: result });
  } catch (err) {
    next(err);
  }
}

export async function sendMessage(req: Request, res: Response, next: NextFunction) {
  try {
    const { params, body } = sendMessageSchema.parse({
      params: req.params,
      body:   req.body,
    });
    const senderId = res.locals.user.id as string;
    const message  = await chatService.sendMessage({
      conversationId: params.conversationId,
      senderId,
      ciphertext: body.ciphertext,
      iv:         body.iv,
      senderDeviceKeyId: body.senderDeviceKeyId,
      envelopes:         body.envelopes,
    });
    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
}

export async function getMessages(req: Request, res: Response, next: NextFunction) {
  try {
    const { params, query } = getMessagesSchema.parse({
      params: req.params,
      query:  req.query,
    });
    const userId = res.locals.user.id as string;
    const result = await chatService.getMessages({
      conversationId: params.conversationId,
      userId,
      cursor: query.cursor,
      limit:  query.limit,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function markRead(req: Request, res: Response, next: NextFunction) {
  try {
    const conversationId = req.params.conversationId as string;
    const userId         = res.locals.user.id as string;
    const result         = await chatService.markConversationRead(conversationId, userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function deleteMessage(req: Request, res: Response, next: NextFunction) {
  try {
    const conversationId = req.params.conversationId as string
    const messageId      = req.params.messageId as string
    const userId         = res.locals.user.id as string
    const scope          = (req.query.scope === "everyone" ? "everyone" : "me") as "me" | "everyone"
    const result         = await chatService.deleteMessage({ conversationId, messageId, userId, scope })
    res.json(result)
  } catch (err) {
    next(err)
  }
}
