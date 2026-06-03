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
    ciphertext: z.string().min(1, "ciphertext is required"),
    iv: z.string().min(1, "iv is required"),
    // Multi-device E2E (optional, additive).
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
