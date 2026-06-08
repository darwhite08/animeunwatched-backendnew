import { prisma } from "../../config/prisma";
import { getIo } from "../../realtime/io-instance";
import { notFound, forbidden, badReq } from "../../lib/errors";
import { pushToUser } from "../../lib/push";
import { computeServerFrank } from "../../lib/franking";

// Group chat lives entirely in its own tables — the 1:1 DM realtime/unread path
// is LOCKED and untouched. Realtime reuses each user's existing `user:<id>` room.

const MAX_MEMBERS = 256;

const MSG_SELECT = {
  id: true, groupId: true, senderId: true, type: true, body: true,
  mediaUrl: true, mediaMime: true, mediaSizeBytes: true, mediaWidth: true,
  mediaHeight: true, mediaDurationS: true, mediaBlurhash: true,
  animeMalId: true, animeEpisode: true, replyToId: true, clientNonce: true,
  ciphertext: true, contentIv: true, frankingTag: true, isE2EE: true,
  createdAt: true, editedAt: true, deletedAt: true,
} as const;

const USER_LITE = { id: true, username: true, displayName: true, avatarUrl: true } as const;

// ─── membership guards ───────────────────────────────────────────────────────
async function assertMember(groupId: string, userId: string) {
  const m = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
    select: { id: true, role: true, leftAt: true, archived: true, mutedUntil: true, lastReadAt: true },
  });
  if (!m || m.leftAt) throw notFound("Group not found"); // IDOR → 404
  return m;
}
async function assertAdmin(groupId: string, userId: string) {
  const m = await assertMember(groupId, userId);
  if (m.role !== "OWNER" && m.role !== "ADMIN") throw forbidden("Admins only");
  return m;
}

async function activeMemberIds(groupId: string): Promise<string[]> {
  const rows = await prisma.groupMember.findMany({
    where: { groupId, leftAt: null }, select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

function emitToMembers(memberIds: string[], event: string, payload: unknown) {
  const io = getIo();
  if (!io) return;
  for (const uid of memberIds) io.to(`user:${uid}`).emit(event, payload);
}

// ─── create / read ───────────────────────────────────────────────────────────
export async function createGroup(ownerId: string, dto: { title: string; avatarUrl?: string; memberIds: string[]; isE2EE?: boolean }) {
  const ids = [...new Set(dto.memberIds.filter((id) => id !== ownerId))];
  if (ids.length < 1) throw badReq("A group needs at least one other member");
  if (ids.length + 1 > MAX_MEMBERS) throw badReq(`Groups are capped at ${MAX_MEMBERS} members`);
  // Only allow adding real users.
  const found = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const validIds = found.map((u) => u.id);
  if (!validIds.length) throw badReq("No valid members");

  const group = await prisma.$transaction(async (tx) => {
    const g = await tx.groupConversation.create({
      data: {
        title: dto.title, avatarUrl: dto.avatarUrl ?? null, ownerId, isE2EE: !!dto.isE2EE,
        members: {
          create: [
            { userId: ownerId, role: "OWNER", addedBy: ownerId },
            ...validIds.map((uid) => ({ userId: uid, role: "MEMBER" as const, addedBy: ownerId })),
          ],
        },
      },
      select: { id: true },
    });
    await tx.groupMessage.create({
      data: { groupId: g.id, senderId: null, type: "SYSTEM", body: "created the group" },
    });
    return g;
  });

  const full = await getGroup(ownerId, group.id);
  emitToMembers([ownerId, ...validIds], "group.created", { group: full.group });
  return full;
}

/** Inbox list — the caller's group memberships with last-message preview + unread. */
export async function listGroups(userId: string, opts: { cursor?: string; limit: number; filter: "active" | "archived" }) {
  const memberships = await prisma.groupMember.findMany({
    where: { userId, leftAt: null, archived: opts.filter === "archived" },
    select: {
      role: true, unreadCount: true, mutedUntil: true, pinned: true, archived: true, lastReadAt: true,
      group: {
        select: {
          id: true, title: true, avatarUrl: true, ownerId: true, lastMessageAt: true, isE2EE: true,
          disappearingSeconds: true,
          _count: { select: { members: { where: { leftAt: null } } } },
          messages: {
            where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 1,
            select: { id: true, type: true, body: true, senderId: true, isE2EE: true, createdAt: true,
              sender: { select: { displayName: true, username: true } } },
          },
        },
      },
    },
    orderBy: { group: { lastMessageAt: "desc" } },
    take: opts.limit,
  });
  const items = memberships;
  const groups = items
    .sort((a, b) => Number(b.pinned) - Number(a.pinned))
    .map((m) => {
      const last = m.group.messages[0];
      return {
        id: m.group.id, title: m.group.title, avatarUrl: m.group.avatarUrl, ownerId: m.group.ownerId,
        isE2EE: m.group.isE2EE, disappearingSeconds: m.group.disappearingSeconds,
        memberCount: m.group._count.members, lastMessageAt: m.group.lastMessageAt,
        myRole: m.role, unreadCount: m.unreadCount, mutedUntil: m.mutedUntil, pinned: m.pinned, archived: m.archived,
        lastMessage: last
          ? { id: last.id, type: last.type, preview: previewOf(last), senderId: last.senderId,
              senderName: last.sender?.displayName ?? last.sender?.username ?? null, createdAt: last.createdAt }
          : null,
      };
    });
  return { groups, nextCursor: null };
}

function previewOf(m: { type: string; body: string | null; isE2EE: boolean }): string | null {
  if (m.isE2EE) return "🔒 Encrypted message";
  if (m.type === "IMAGE") return "📷 Photo";
  if (m.type === "VOICE") return "🎤 Voice message";
  if (m.type === "ANIME_CARD") return "🎬 Anime";
  if (m.type === "SYSTEM") return m.body;
  return m.body?.slice(0, 120) ?? null;
}

export async function getGroup(userId: string, groupId: string) {
  await assertMember(groupId, userId);
  const g = await prisma.groupConversation.findUnique({
    where: { id: groupId },
    select: {
      id: true, title: true, avatarUrl: true, ownerId: true, isE2EE: true,
      disappearingSeconds: true, createdAt: true, lastMessageAt: true,
      members: {
        where: { leftAt: null },
        select: { userId: true, role: true, joinedAt: true, user: { select: USER_LITE } },
        orderBy: { joinedAt: "asc" },
      },
    },
  });
  if (!g) throw notFound("Group not found");
  const me = g.members.find((m) => m.userId === userId);
  return {
    group: {
      ...g,
      memberCount: g.members.length,
      myRole: me?.role ?? "MEMBER",
      members: g.members.map((m) => ({ ...m.user, role: m.role, joinedAt: m.joinedAt })),
    },
  };
}

/** Active devices of all members — for the client to wrap CKs (E2EE groups). */
export async function getGroupDevices(userId: string, groupId: string) {
  const memberIds = (await assertMemberIds(groupId, userId));
  const devices = await prisma.userDevice.findMany({
    where: { userId: { in: memberIds }, revoked: false },
    select: { id: true, userId: true, publicKey: true },
  });
  return { devices };
}
async function assertMemberIds(groupId: string, userId: string): Promise<string[]> {
  await assertMember(groupId, userId);
  return activeMemberIds(groupId);
}

// ─── messages ────────────────────────────────────────────────────────────────
type SendDto = {
  type?: "TEXT" | "IMAGE" | "VOICE" | "ANIME_CARD";
  body?: string; replyToId?: string; animeMalId?: number; animeEpisode?: number; clientNonce?: string;
  media?: { mediaUrl: string; mediaMime?: string; mediaSizeBytes?: number; mediaWidth?: number; mediaHeight?: number; mediaDurationS?: number; mediaBlurhash?: string };
  e2ee?: { ciphertext: string; contentIv: string; frankingTag: string; envelopes: { deviceId: string; ephemeralPub: string; wrappedCK: string; wrapIv: string }[] };
};

export async function sendGroupMessage(senderId: string, groupId: string, dto: SendDto) {
  await assertMember(groupId, senderId);
  const group = await prisma.groupConversation.findUnique({
    where: { id: groupId }, select: { disappearingSeconds: true },
  });
  if (!group) throw notFound("Group not found");

  const type = dto.type ?? "TEXT";
  const data: Record<string, unknown> = {};
  let body: string | null = null;

  if (dto.e2ee) {
    data.isE2EE = true;
    data.ciphertext = dto.e2ee.ciphertext;
    data.contentIv = dto.e2ee.contentIv;
    data.frankingTag = dto.e2ee.frankingTag;
    if (type === "ANIME_CARD") { if (!dto.animeMalId) throw badReq("animeMalId required"); data.animeMalId = dto.animeMalId; if (dto.animeEpisode != null) data.animeEpisode = dto.animeEpisode; }
    if ((type === "IMAGE" || type === "VOICE") && dto.media?.mediaUrl) Object.assign(data, dto.media);
  } else if (type === "TEXT") {
    const raw = (dto.body ?? "").trim();
    if (raw.length < 1 || raw.length > 4000) throw badReq("Message must be 1–4000 characters");
    body = raw;
  } else if (type === "IMAGE" || type === "VOICE") {
    if (!dto.media?.mediaUrl) throw badReq("Invalid media URL");
    Object.assign(data, dto.media);
    body = dto.body ? dto.body.slice(0, 4000) : null;
  } else if (type === "ANIME_CARD") {
    if (!dto.animeMalId) throw badReq("animeMalId required");
    data.animeMalId = dto.animeMalId;
    if (dto.animeEpisode != null) data.animeEpisode = dto.animeEpisode;
    body = dto.body ? dto.body.slice(0, 4000) : null;
  }

  if (dto.replyToId) {
    const parent = await prisma.groupMessage.findUnique({ where: { id: dto.replyToId }, select: { groupId: true } });
    if (!parent || parent.groupId !== groupId) throw badReq("Invalid replyToId");
    data.replyToId = dto.replyToId;
  }

  const now = new Date();
  const memberIds = await activeMemberIds(groupId);
  const others = memberIds.filter((id) => id !== senderId);

  const created = await prisma.$transaction(async (tx) => {
    const msg = await tx.groupMessage.create({
      data: {
        groupId, senderId, type,
        ...(body != null ? { body } : {}),
        ...(dto.clientNonce ? { clientNonce: dto.clientNonce } : {}),
        ...(group.disappearingSeconds ? { expiresAt: new Date(now.getTime() + group.disappearingSeconds * 1000) } : {}),
        ...data,
      },
      select: MSG_SELECT,
    });
    await tx.groupConversation.update({ where: { id: groupId }, data: { lastMessageAt: now, updatedAt: now } });
    // Bump unread for everyone except the sender (un-archive on new activity).
    await tx.groupMember.updateMany({
      where: { groupId, userId: { in: others } },
      data: { unreadCount: { increment: 1 }, archived: false },
    });
    if (dto.e2ee) {
      const serverFrank = computeServerFrank({ frankingTag: dto.e2ee.frankingTag, messageId: msg.id, senderId, ts: msg.createdAt.getTime() });
      await tx.groupMessage.update({ where: { id: msg.id }, data: { serverFrank } });
      if (dto.e2ee.envelopes.length) {
        await tx.groupMessageEnvelope.createMany({
          data: dto.e2ee.envelopes.map((e) => ({ messageId: msg.id, deviceId: e.deviceId, ephemeralPub: e.ephemeralPub, wrappedCK: e.wrappedCK, wrapIv: e.wrapIv })),
          skipDuplicates: true,
        });
      }
    }
    return msg;
  });

  const sender = await prisma.user.findUnique({ where: { id: senderId }, select: USER_LITE });
  const replyTo = data.replyToId
    ? await prisma.groupMessage.findUnique({ where: { id: data.replyToId as string }, select: { id: true, senderId: true, type: true, body: true, deletedAt: true } })
    : null;
  const wire = { ...created, sender, replyTo, reactions: [] as unknown[] };

  // Realtime: full message (with this msg's envelopes) to every member's room.
  // Each client keeps only the envelope addressed to its own device.
  emitToMembers(memberIds, "group.message", { ...wire, e2eeEnvelopes: dto.e2ee?.envelopes ?? [] });
  emitToMembers([senderId], "group.sent", { nonce: dto.clientNonce ?? null, groupId, message: wire });

  // Push notify non-muted members.
  void notifyMembers(groupId, senderId, others, wire);
  return { message: wire };
}

async function notifyMembers(groupId: string, senderId: string, others: string[], msg: { type: string; body: string | null; isE2EE: boolean }) {
  try {
    const [group, members, sender] = await Promise.all([
      prisma.groupConversation.findUnique({ where: { id: groupId }, select: { title: true } }),
      prisma.groupMember.findMany({ where: { groupId, userId: { in: others }, OR: [{ mutedUntil: null }, { mutedUntil: { lt: new Date() } }] }, select: { userId: true } }),
      prisma.user.findUnique({ where: { id: senderId }, select: { displayName: true, username: true } }),
    ]);
    const who = sender?.displayName ?? sender?.username ?? "Someone";
    const preview = previewOf(msg) ?? "New message";
    for (const m of members) {
      void pushToUser(m.userId, {
        title: group?.title ?? "Group",
        body: `${who}: ${preview}`,
        data: { type: "group_message", groupId },
      });
    }
  } catch { /* push is best-effort */ }
}

export async function getMessages(userId: string, groupId: string, opts: { cursor?: string; limit: number }) {
  await assertMember(groupId, userId);
  const messages = await prisma.groupMessage.findMany({
    where: {
      groupId,
      ...(opts.cursor ? { createdAt: { lt: new Date(opts.cursor) } } : {}),
      NOT: { expiresAt: { lt: new Date() } },
      hides: { none: { userId } }, // "delete for me"
    },
    orderBy: { createdAt: "desc" },
    take: opts.limit + 1,
    select: {
      ...MSG_SELECT,
      sender: { select: USER_LITE },
      replyTo: { select: { id: true, senderId: true, type: true, body: true, deletedAt: true } },
      reactions: { select: { emoji: true, userId: true } },
    },
  });
  const hasMore = messages.length > opts.limit;
  const items = hasMore ? messages.slice(0, opts.limit) : messages;

  // E2EE envelopes addressed to THIS user's devices (GroupMessageEnvelope has no
  // FK to UserDevice — fetch my device ids, then the matching envelopes).
  const myDeviceIds = (await prisma.userDevice.findMany({ where: { userId }, select: { id: true } })).map((d) => d.id);
  const envByMsg = new Map<string, { deviceId: string; ephemeralPub: string; wrappedCK: string; wrapIv: string }[]>();
  if (myDeviceIds.length) {
    const envs = await prisma.groupMessageEnvelope.findMany({
      where: { messageId: { in: items.map((m) => m.id) }, deviceId: { in: myDeviceIds } },
      select: { messageId: true, deviceId: true, ephemeralPub: true, wrappedCK: true, wrapIv: true },
    });
    for (const e of envs) {
      const arr = envByMsg.get(e.messageId) ?? [];
      arr.push({ deviceId: e.deviceId, ephemeralPub: e.ephemeralPub, wrappedCK: e.wrappedCK, wrapIv: e.wrapIv });
      envByMsg.set(e.messageId, arr);
    }
  }

  const withExtras = items.map((m) => {
    const byEmoji = new Map<string, { emoji: string; count: number; reactedByMe: boolean }>();
    for (const r of m.reactions) {
      const e = byEmoji.get(r.emoji) ?? { emoji: r.emoji, count: 0, reactedByMe: false };
      e.count += 1; if (r.userId === userId) e.reactedByMe = true; byEmoji.set(r.emoji, e);
    }
    return { ...m, envelopesV2: envByMsg.get(m.id) ?? [], reactions: [...byEmoji.values()] };
  });
  return { messages: withExtras, nextCursor: hasMore ? items[items.length - 1].createdAt.toISOString() : null };
}

export async function markRead(userId: string, groupId: string) {
  await assertMember(groupId, userId);
  await prisma.groupMember.update({
    where: { groupId_userId: { groupId, userId } },
    data: { unreadCount: 0, lastReadAt: new Date() },
  });
  return { ok: true };
}

export async function unreadCount(userId: string) {
  const rows = await prisma.groupMember.findMany({
    where: { userId, leftAt: null, archived: false }, select: { unreadCount: true },
  });
  return { count: rows.reduce((n, r) => n + r.unreadCount, 0) };
}

// ─── membership management ───────────────────────────────────────────────────
export async function addMembers(actorId: string, groupId: string, memberIds: string[]) {
  await assertAdmin(groupId, actorId);
  const existing = await prisma.groupMember.findMany({ where: { groupId }, select: { userId: true, leftAt: true } });
  const activeCount = existing.filter((m) => !m.leftAt).length;
  const ids = [...new Set(memberIds)];
  const valid = (await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((u) => u.id);
  if (activeCount + valid.length > MAX_MEMBERS) throw badReq(`Groups are capped at ${MAX_MEMBERS} members`);

  for (const uid of valid) {
    await prisma.groupMember.upsert({
      where: { groupId_userId: { groupId, userId: uid } },
      update: { leftAt: null, role: "MEMBER", addedBy: actorId },
      create: { groupId, userId: uid, role: "MEMBER", addedBy: actorId },
    });
  }
  const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { displayName: true, username: true } });
  const added = await prisma.user.findMany({ where: { id: { in: valid } }, select: { displayName: true, username: true } });
  const names = added.map((u) => u.displayName ?? u.username).join(", ");
  await systemMessage(groupId, `${actor?.displayName ?? actor?.username ?? "Someone"} added ${names}`);
  const full = await getGroup(actorId, groupId);
  emitToMembers(await activeMemberIds(groupId), "group.updated", { group: full.group });
  return full;
}

export async function removeMember(actorId: string, groupId: string, targetId: string) {
  const me = await assertAdmin(groupId, actorId);
  const target = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId: targetId } }, select: { role: true, leftAt: true } });
  if (!target || target.leftAt) throw notFound("Member not found");
  if (target.role === "OWNER") throw forbidden("Can't remove the owner");
  if (target.role === "ADMIN" && me.role !== "OWNER") throw forbidden("Only the owner can remove an admin");
  const memberIdsBefore = await activeMemberIds(groupId);
  await prisma.groupMember.update({ where: { groupId_userId: { groupId, userId: targetId } }, data: { leftAt: new Date() } });
  const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { displayName: true, username: true } });
  const t = await prisma.user.findUnique({ where: { id: targetId }, select: { displayName: true, username: true } });
  await systemMessage(groupId, `${actor?.displayName ?? actor?.username} removed ${t?.displayName ?? t?.username}`);
  emitToMembers(memberIdsBefore, "group.member_removed", { groupId, userId: targetId });
  return { ok: true };
}

export async function leaveGroup(userId: string, groupId: string) {
  const me = await assertMember(groupId, userId);
  const memberIds = await activeMemberIds(groupId);
  await prisma.$transaction(async (tx) => {
    await tx.groupMember.update({ where: { groupId_userId: { groupId, userId } }, data: { leftAt: new Date() } });
    if (me.role === "OWNER") {
      // Hand ownership to the oldest remaining admin, else oldest member.
      const next = await tx.groupMember.findFirst({
        where: { groupId, leftAt: null, userId: { not: userId } },
        orderBy: [{ role: "asc" }, { joinedAt: "asc" }], select: { userId: true },
      });
      if (next) {
        await tx.groupMember.update({ where: { groupId_userId: { groupId, userId: next.userId } }, data: { role: "OWNER" } });
        await tx.groupConversation.update({ where: { id: groupId }, data: { ownerId: next.userId } });
      }
    }
  });
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true, username: true } });
  await systemMessage(groupId, `${u?.displayName ?? u?.username} left`);
  emitToMembers(memberIds, "group.member_removed", { groupId, userId });
  return { ok: true };
}

export async function setRole(actorId: string, groupId: string, targetId: string, role: "ADMIN" | "MEMBER") {
  const me = await assertMember(groupId, actorId);
  if (me.role !== "OWNER") throw forbidden("Only the owner can change roles");
  const target = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId: targetId } }, select: { role: true, leftAt: true } });
  if (!target || target.leftAt) throw notFound("Member not found");
  if (target.role === "OWNER") throw forbidden("Can't change the owner's role");
  await prisma.groupMember.update({ where: { groupId_userId: { groupId, userId: targetId } }, data: { role } });
  const full = await getGroup(actorId, groupId);
  emitToMembers(await activeMemberIds(groupId), "group.updated", { group: full.group });
  return full;
}

export async function updateGroup(actorId: string, groupId: string, patch: { title?: string; avatarUrl?: string | null; disappearingSeconds?: number | null }) {
  await assertAdmin(groupId, actorId);
  const data: Record<string, unknown> = {};
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.avatarUrl !== undefined) data.avatarUrl = patch.avatarUrl;
  if (patch.disappearingSeconds !== undefined) data.disappearingSeconds = patch.disappearingSeconds === 0 ? null : patch.disappearingSeconds;
  await prisma.groupConversation.update({ where: { id: groupId }, data });
  if (patch.title !== undefined || patch.disappearingSeconds !== undefined) {
    const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { displayName: true, username: true } });
    const who = actor?.displayName ?? actor?.username ?? "Someone";
    if (patch.title !== undefined) await systemMessage(groupId, `${who} renamed the group to "${patch.title}"`);
    if (patch.disappearingSeconds !== undefined) await systemMessage(groupId, patch.disappearingSeconds ? `${who} turned on disappearing messages` : `${who} turned off disappearing messages`);
  }
  const full = await getGroup(actorId, groupId);
  emitToMembers(await activeMemberIds(groupId), "group.updated", { group: full.group });
  return full;
}

// Per-member inbox toggles.
export async function muteGroup(userId: string, groupId: string, mutedUntil: string | null) {
  await assertMember(groupId, userId);
  await prisma.groupMember.update({ where: { groupId_userId: { groupId, userId } }, data: { mutedUntil: mutedUntil ? new Date(mutedUntil) : null } });
  return { ok: true };
}
export async function pinGroup(userId: string, groupId: string, value: boolean) {
  await assertMember(groupId, userId);
  await prisma.groupMember.update({ where: { groupId_userId: { groupId, userId } }, data: { pinned: value } });
  return { ok: true };
}
export async function archiveGroup(userId: string, groupId: string, value: boolean) {
  await assertMember(groupId, userId);
  await prisma.groupMember.update({ where: { groupId_userId: { groupId, userId } }, data: { archived: value } });
  return { ok: true };
}

// ─── message edit / delete / reactions ───────────────────────────────────────
export async function editMessage(userId: string, groupId: string, messageId: string, newBody: string) {
  await assertMember(groupId, userId);
  const msg = await prisma.groupMessage.findUnique({ where: { id: messageId }, select: { groupId: true, senderId: true, isE2EE: true, deletedAt: true } });
  if (!msg || msg.groupId !== groupId) throw notFound("Message not found");
  if (msg.senderId !== userId) throw forbidden("You can only edit your own messages");
  if (msg.deletedAt) throw badReq("Message is deleted");
  if (msg.isE2EE) throw badReq("Encrypted messages can't be edited");
  const updated = await prisma.groupMessage.update({ where: { id: messageId }, data: { body: newBody.trim(), editedAt: new Date() }, select: MSG_SELECT });
  emitToMembers(await activeMemberIds(groupId), "group.edited", { groupId, message: updated });
  return { message: updated };
}

export async function deleteMessage(userId: string, groupId: string, messageId: string, scope: "me" | "everyone") {
  const me = await assertMember(groupId, userId);
  const msg = await prisma.groupMessage.findUnique({ where: { id: messageId }, select: { groupId: true, senderId: true } });
  if (!msg || msg.groupId !== groupId) throw notFound("Message not found");
  if (scope === "me") {
    await prisma.groupMessageHide.upsert({ where: { messageId_userId: { messageId, userId } }, update: {}, create: { messageId, userId } });
    return { ok: true };
  }
  const isAdmin = me.role === "OWNER" || me.role === "ADMIN";
  if (msg.senderId !== userId && !isAdmin) throw forbidden("Can't delete others' messages");
  await prisma.groupMessage.update({
    where: { id: messageId },
    data: { deletedAt: new Date(), body: null, ciphertext: null, contentIv: null, frankingTag: null, mediaUrl: null, mediaMime: null, mediaBlurhash: null },
  });
  emitToMembers(await activeMemberIds(groupId), "group.deleted", { groupId, messageId, scope: "everyone" });
  return { ok: true };
}

export async function setReaction(userId: string, groupId: string, messageId: string, emoji: string) {
  await assertMember(groupId, userId);
  const msg = await prisma.groupMessage.findUnique({ where: { id: messageId }, select: { groupId: true } });
  if (!msg || msg.groupId !== groupId) throw notFound("Message not found");
  const existing = await prisma.groupMessageReaction.findUnique({ where: { messageId_userId_emoji: { messageId, userId, emoji } } });
  if (existing) await prisma.groupMessageReaction.delete({ where: { id: existing.id } });
  else await prisma.groupMessageReaction.create({ data: { messageId, userId, emoji } });
  emitToMembers(await activeMemberIds(groupId), "group.reaction", { groupId, messageId, emoji, userId, removed: !!existing });
  return { ok: true };
}

async function systemMessage(groupId: string, text: string) {
  const now = new Date();
  const msg = await prisma.groupMessage.create({ data: { groupId, senderId: null, type: "SYSTEM", body: text }, select: MSG_SELECT });
  await prisma.groupConversation.update({ where: { id: groupId }, data: { lastMessageAt: now } });
  emitToMembers(await activeMemberIds(groupId), "group.message", { ...msg, sender: null, replyTo: null, reactions: [], e2eeEnvelopes: [] });
}
