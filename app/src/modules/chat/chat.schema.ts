import { z } from "zod";

export const uploadPublicKeySchema = z.object({
  body: z.object({
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
