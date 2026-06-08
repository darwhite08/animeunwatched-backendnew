import { Request, Response, NextFunction } from "express";
import * as chatService from "./chat.service";
import {
  uploadPublicKeySchema,
  registerDeviceKeySchema,
  startConversationSchema,
  sendMessageSchema,
  getMessagesSchema,
  reactionSchema,
  listConversationsSchema,
  editMessageSchema,
  putReactionSchema,
  muteSchema,
  searchConversationSchema,
} from "./chat.schema";

export async function addReaction(req: Request, res: Response, next: NextFunction) {
  try {
    const { params, body } = reactionSchema.parse({ params: req.params, body: req.body });
    await chatService.addReaction(res.locals.user.id as string, params.messageId, body.emoji);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function removeReaction(req: Request, res: Response, next: NextFunction) {
  try {
    const { params, body } = reactionSchema.parse({ params: req.params, body: req.body });
    await chatService.removeReaction(res.locals.user.id as string, params.messageId, body.emoji);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

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
    const { query } = listConversationsSchema.parse({ query: req.query });
    const userId = res.locals.user.id as string;
    const result = await chatService.listConversations(userId, query);
    // `conversations` kept for back-compat with the current mobile client;
    // `data`/`meta` is the cursor-paginated shape.
    res.json({ conversations: result.data, data: result.data, meta: result.meta });
  } catch (err) {
    next(err);
  }
}

export async function unreadCount(req: Request, res: Response, next: NextFunction) {
  try {
    const { count, requests } = await chatService.unreadCount(res.locals.user.id as string);
    res.json({ count, requests });
  } catch (err) {
    next(err);
  }
}

export async function linkPreview(req: Request, res: Response, next: NextFunction) {
  try {
    const url = String(req.query.url ?? "");
    if (!url) { res.status(400).json({ error: { code: "BAD_REQUEST", message: "url required" } }); return; }
    const { linkPreview } = await import("./chatExtras.service");
    res.json(await linkPreview(url));
  } catch (err) { next(err); }
}

export async function gifs(req: Request, res: Response, next: NextFunction) {
  try {
    const { searchGifs } = await import("./chatExtras.service");
    res.json(await searchGifs(String(req.query.q ?? "")));
  } catch (err) { next(err); }
}

export async function getPresence(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await chatService.getPresence(res.locals.user.id as string, req.params.userId as string);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function editMessage(req: Request, res: Response, next: NextFunction) {
  try {
    const { params, body } = editMessageSchema.parse({ params: req.params, body: req.body });
    const result = await chatService.editMessage(res.locals.user.id as string, params.id, body.body);
    res.json({ message: result });
  } catch (err) {
    next(err);
  }
}

export async function putReaction(req: Request, res: Response, next: NextFunction) {
  try {
    const { params, body } = putReactionSchema.parse({ params: req.params, body: req.body });
    const userId = res.locals.user.id as string;
    if (body.emoji === null) {
      // Clear whatever reaction this user has on the message.
      await chatService.clearReaction(userId, params.id);
    } else {
      await chatService.addReaction(userId, params.id, body.emoji);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function acceptRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await chatService.acceptRequest(res.locals.user.id as string, req.params.conversationId as string);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function declineRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await chatService.declineRequest(res.locals.user.id as string, req.params.conversationId as string);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function muteConversation(req: Request, res: Response, next: NextFunction) {
  try {
    const { params, body } = muteSchema.parse({ params: req.params, body: req.body });
    const until = body.until === null ? null : body.until === "forever" ? new Date("9999-12-31") : new Date(body.until);
    const result = await chatService.muteConversation(res.locals.user.id as string, params.conversationId, until);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function pinConversation(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await chatService.pinConversation(res.locals.user.id as string, req.params.conversationId as string, req.body?.pinned !== false);
    res.json(result);
  } catch (err) { next(err); }
}

export async function archiveConversation(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await chatService.archiveConversation(res.locals.user.id as string, req.params.conversationId as string, req.body?.archived !== false);
    res.json(result);
  } catch (err) { next(err); }
}

export async function deleteConversation(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await chatService.deleteConversationForMe(res.locals.user.id as string, req.params.conversationId as string);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function searchConversation(req: Request, res: Response, next: NextFunction) {
  try {
    const { params, query } = searchConversationSchema.parse({ params: req.params, query: req.query });
    const result = await chatService.searchConversation(res.locals.user.id as string, params.conversationId, query.q);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// Inline reply from a system notification — token-authenticated (see service).
export async function pushReply(req: Request, res: Response, next: NextFunction) {
  try {
    const token = String(req.body?.token ?? "");
    const content = String(req.body?.content ?? "").trim().slice(0, 2000);
    if (!token || !content) {
      res.status(400).json({ error: { code: "BAD_REQUEST", message: "token and content required" } });
      return;
    }
    const message = await chatService.sendPushReply(token, content);
    res.status(201).json({ message });
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
      type:        body.type,
      body:        body.body,
      replyToId:   body.replyToId,
      animeMalId:  body.animeMalId,
      animeEpisode: body.animeEpisode,
      clientNonce: body.clientNonce,
      media:       body.media,
      ciphertext: body.ciphertext,
      iv:         body.iv,
      senderDeviceKeyId: body.senderDeviceKeyId,
      envelopes:         body.envelopes,
      e2ee:              body.e2ee,
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
