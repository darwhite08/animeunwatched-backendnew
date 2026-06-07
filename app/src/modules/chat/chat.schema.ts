import { z } from "zod";

export const uploadPublicKeySchema = z.object({
  body: z.object({
    publicKey: z.string().min(1, "publicKey is required"),
  }),
});

// Multi-device E2E (Phase 1, additive)
export const registerDeviceKeySchema = z.object({
  body: z.object({
    deviceId:  z.string().min(1, "deviceId is required").max(128),
    publicKey: z.string().min(1, "publicKey is required"),
  }),
});

export const startConversationSchema = z.object({
  body: z.object({
    recipientId: z.string().min(1, "recipientId is required"),
  }),
});

export const sendMessageSchema = z.object({
  params: z.object({
    conversationId: z.string().min(1),
  }),
  body: z.object({
    // v2 server-readable content (optional so the legacy E2E path still validates)
    type: z.enum(["TEXT", "IMAGE", "VOICE", "ANIME_CARD"]).optional(),
    body: z.string().max(4000).optional(),
    replyToId: z.string().min(1).optional(),
    animeMalId: z.number().int().positive().optional(),
    animeEpisode: z.number().int().positive().optional(),
    clientNonce: z.string().min(1).max(64).optional(),
    media: z.object({
      mediaUrl: z.string().url(),
      mediaMime: z.string().max(100).optional(),
      mediaSizeBytes: z.number().int().positive().optional(),
      mediaWidth: z.number().int().positive().optional(),
      mediaHeight: z.number().int().positive().optional(),
      mediaDurationS: z.number().int().positive().optional(),
      mediaBlurhash: z.string().max(200).optional(),
    }).optional(),
    // Legacy E2E (optional, additive).
    ciphertext: z.string().min(1).optional(),
    iv: z.string().min(1).optional(),
    senderDeviceKeyId: z.string().min(1).optional(),
    envelopes: z
      .array(
        z.object({
          recipientDeviceKeyId: z.string().min(1),
          wrappedKey: z.string().min(1),
          wrapIv: z.string().min(1),
        }),
      )
      .max(50)
      .optional(),
  }),
});

export const listConversationsSchema = z.object({
  query: z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    filter: z.enum(["active", "requests"]).default("active"),
  }),
});

export const editMessageSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({ body: z.string().min(1).max(4000) }),
});

export const putReactionSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({ emoji: z.string().min(1).max(64).nullable() }),
});

export const muteSchema = z.object({
  params: z.object({ conversationId: z.string().min(1) }),
  body: z.object({ until: z.union([z.string(), z.literal("forever"), z.null()]) }),
});

export const searchConversationSchema = z.object({
  params: z.object({ conversationId: z.string().min(1) }),
  query: z.object({ q: z.string().min(1).max(200) }),
});

export const getMessagesSchema = z.object({
  params: z.object({
    conversationId: z.string().min(1),
  }),
  query: z.object({
    cursor: z.string().optional(),
    limit:  z.coerce.number().int().min(1).max(50).default(30),
  }),
});

export const reactionSchema = z.object({
  params: z.object({ messageId: z.string().min(1) }),
  body:   z.object({ emoji: z.string().min(1).max(16) }),
});
