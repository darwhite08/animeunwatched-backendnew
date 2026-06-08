import { z } from "zod";

export const createGroupSchema = z.object({
  body: z.object({
    title: z.string().trim().min(1).max(80),
    avatarUrl: z.string().url().max(500).optional(),
    memberIds: z.array(z.string().min(1)).min(1).max(256),
    isE2EE: z.boolean().optional(),
  }),
});

export const listGroupsSchema = z.object({
  query: z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    filter: z.enum(["active", "archived"]).default("active"),
  }),
});

export const groupIdSchema = z.object({
  params: z.object({ groupId: z.string().min(1) }),
});

export const getMessagesSchema = z.object({
  params: z.object({ groupId: z.string().min(1) }),
  query: z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  }),
});

const envelopeSchema = z.object({
  deviceId: z.string().min(1),
  ephemeralPub: z.string().min(1).max(512),
  wrappedCK: z.string().min(1).max(2048),
  wrapIv: z.string().min(1).max(512),
});

export const sendMessageSchema = z.object({
  params: z.object({ groupId: z.string().min(1) }),
  body: z.object({
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
    e2ee: z.object({
      ciphertext: z.string().min(1).max(100000),
      contentIv: z.string().min(1).max(512),
      frankingTag: z.string().min(1).max(512),
      envelopes: z.array(envelopeSchema).min(1).max(2048),
    }).optional(),
  }),
});

export const updateGroupSchema = z.object({
  params: z.object({ groupId: z.string().min(1) }),
  body: z.object({
    title: z.string().trim().min(1).max(80).optional(),
    avatarUrl: z.string().url().max(500).nullable().optional(),
    disappearingSeconds: z.number().int().min(0).max(60 * 60 * 24 * 7).nullable().optional(),
  }),
});

export const addMembersSchema = z.object({
  params: z.object({ groupId: z.string().min(1) }),
  body: z.object({ memberIds: z.array(z.string().min(1)).min(1).max(256) }),
});

export const memberParamSchema = z.object({
  params: z.object({ groupId: z.string().min(1), userId: z.string().min(1) }),
});

export const setRoleSchema = z.object({
  params: z.object({ groupId: z.string().min(1), userId: z.string().min(1) }),
  body: z.object({ role: z.enum(["ADMIN", "MEMBER"]) }),
});

export const toggleSchema = z.object({
  params: z.object({ groupId: z.string().min(1) }),
  body: z.object({ value: z.boolean().optional(), mutedUntil: z.string().datetime().nullable().optional() }),
});

export const messageIdSchema = z.object({
  params: z.object({ groupId: z.string().min(1), messageId: z.string().min(1) }),
});

export const editMessageSchema = z.object({
  params: z.object({ groupId: z.string().min(1), messageId: z.string().min(1) }),
  body: z.object({ body: z.string().min(1).max(4000) }),
});

export const reactionSchema = z.object({
  params: z.object({ groupId: z.string().min(1), messageId: z.string().min(1) }),
  body: z.object({ emoji: z.string().min(1).max(32) }),
});

export const deleteMessageSchema = z.object({
  params: z.object({ groupId: z.string().min(1), messageId: z.string().min(1) }),
  query: z.object({ scope: z.enum(["me", "everyone"]).default("everyone") }),
});
