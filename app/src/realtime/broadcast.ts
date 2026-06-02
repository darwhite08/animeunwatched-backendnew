/**
 * Centralized realtime broadcast helpers.
 *
 * Every event is fire-and-forget — if the Socket.io server hasn't started yet
 * (e.g. during tests, or before the first request), the helpers are no-ops
 * instead of throwing. Adding a new realtime feature = add an emit function
 * here, then call it from the corresponding service. No service touches
 * `getIo()` directly so it's easy to find every broadcast in one place.
 */
import { getIo } from "./io-instance"
import { enqueueWebhook } from "../jobs/webhookDispatcher.job"

/**
 * Fan an event out to every subscribed webhook endpoint. Fire-and-forget:
 * never blocks the primary request, errors are logged not thrown.
 */
function enqueueOutbound(eventName: string, payload: Record<string, unknown>): Promise<void> {
  return enqueueWebhook(eventName, payload).catch(err => {
    console.error("[webhook-enqueue]", eventName, "failed:", err)
  })
}

// ── Room names ───────────────────────────────────────────────────────────────

export const FEED_ROOM            = "feed"
export const ADMIN_ROOM           = "admin"
export const animeRoom    = (malId: number) => `anime:${malId}`
export const clubRoom     = (clubId: string) => `club:${clubId}`
export const threadRoom   = (threadId: string) => `thread:${threadId}`
export const postRoom     = (postId: string) => `post:${postId}`
export const userRoom     = (userId: string) => `user:${userId}`

// ── Generic helper ───────────────────────────────────────────────────────────

function emit(room: string, event: string, payload: unknown): void {
  const io = getIo()
  if (!io) return
  io.to(room).emit(event, payload)
}

// ── Post events ──────────────────────────────────────────────────────────────

export function broadcastPostCreated(post: unknown): void {
  emit(FEED_ROOM, "post.created", post)
}

export function broadcastPostLiked(postId: string, authorId: string, likes: number, likerId: string): void {
  emit(FEED_ROOM, "post.liked",   { postId, likes, likerId })
  emit(userRoom(authorId), "post.liked", { postId, likes, likerId })
}

export function broadcastPostUnliked(postId: string, authorId: string, likes: number): void {
  emit(FEED_ROOM, "post.unliked", { postId, likes })
  emit(userRoom(authorId), "post.unliked", { postId, likes })
}

export function broadcastPostCommented(postId: string, authorId: string, commentCount: number): void {
  emit(FEED_ROOM, "post.commented", { postId, comments: commentCount })
  emit(userRoom(authorId), "post.commented", { postId, comments: commentCount })
}

/** A new comment was written on a post — sent to the post's own room so viewers see it instantly */
export function broadcastPostComment(postId: string, comment: unknown): void {
  emit(postRoom(postId), "post.comment.new", comment)
}

export function broadcastPostDeleted(postId: string): void {
  emit(FEED_ROOM, "post.deleted", { postId })
}

// ── Anime events ─────────────────────────────────────────────────────────────

/** Someone added/removed/changed status on the anime — drives the live user-stats counters */
export function broadcastAnimeListChanged(malId: number): void {
  emit(animeRoom(malId), "anime.list-changed", { malId, at: Date.now() })
}

/** A user updated their own list — sync their watchlist tabs/devices */
export function broadcastUserListChanged(userId: string, malId: number, status: string | null): void {
  emit(userRoom(userId), "list.changed", { malId, status, at: Date.now() })
}

// ── Platform-wide activity (drives the live activity ticker on dashboard) ────

export type PlatformActivity = {
  kind: "watched" | "rated" | "reviewed" | "posted" | "followed"
  actor: { id: string; username: string; displayName: string; avatarUrl: string | null }
  target?: { kind: "anime" | "user" | "post"; label: string; malId?: number; username?: string; id?: string }
  status?: string | null
  score?: number | null
  at: number
}

export function broadcastPlatformActivity(activity: PlatformActivity): void {
  emit(FEED_ROOM, "activity.new", activity)
}

// ── Admin events — emitted ONLY to the `admin` room ─────────────────────────
//
// Subscribers: the admin dashboard at admin-dashboard.kaiveron.com. Every
// emit is also a hint for the admin React Query cache to invalidate, so the
// payload itself is minimal — the client refetches authoritative data.

export function broadcastAdminUserSignup(user: { id: string; username: string; displayName: string; createdAt: string | Date }): void {
  emit(ADMIN_ROOM, "admin.user.created", {
    id:          user.id,
    username:    user.username,
    displayName: user.displayName,
    createdAt:   typeof user.createdAt === "string" ? user.createdAt : user.createdAt.toISOString(),
  })
}

export function broadcastAdminUserBan(userId: string, banned: boolean, actorId: string): void {
  emit(ADMIN_ROOM, banned ? "admin.user.banned" : "admin.user.unbanned", { userId, actorId, at: Date.now() })
  void enqueueOutbound(banned ? "user.banned" : "user.unbanned", { userId, actorId, at: Date.now() })
}

export function broadcastAdminUserRole(userId: string, role: "USER" | "MOD" | "ADMIN", actorId: string): void {
  emit(ADMIN_ROOM, "admin.user.role-changed", { userId, role, actorId, at: Date.now() })
}

export function broadcastAdminPostCreated(): void {
  emit(ADMIN_ROOM, "admin.post.created", { at: Date.now() })
  void enqueueOutbound("post.created", { at: Date.now() })
}

export function broadcastAdminPostDeleted(postId: string, actorId: string): void {
  emit(ADMIN_ROOM, "admin.post.deleted", { postId, actorId, at: Date.now() })
  void enqueueOutbound("post.deleted", { postId, actorId, at: Date.now() })
}

export function broadcastAdminReportCreated(report: { id: string; targetType: string; reason: string }): void {
  emit(ADMIN_ROOM, "admin.report.created", { ...report, at: Date.now() })
  void enqueueOutbound("report.created", { ...report, at: Date.now() })
}

export function broadcastAdminReportResolved(reportId: string, status: "RESOLVED" | "DISMISSED", actorId: string): void {
  emit(ADMIN_ROOM, "admin.report.resolved", { reportId, status, actorId, at: Date.now() })
}

export function broadcastAdminAuditEvent(type: string, userId: string | null): void {
  emit(ADMIN_ROOM, "admin.audit.appended", { type, userId, at: Date.now() })
}

export function broadcastAdminAnalyticsLive(snapshot: unknown): void {
  emit(ADMIN_ROOM, "admin.analytics.live", snapshot)
}

export function broadcastReviewCreated(malId: number, review: unknown): void {
  emit(animeRoom(malId), "review.created", review)
}

// ── Thread events (clubs / anime discussions) ────────────────────────────────

export function broadcastThreadReply(threadId: string, reply: unknown): void {
  emit(threadRoom(threadId), "thread.reply", reply)
}

export function broadcastThreadCreated(parentRoom: string, thread: unknown): void {
  emit(parentRoom, "thread.created", thread)
}

// ── Follow events ────────────────────────────────────────────────────────────

export function broadcastFollow(followerId: string, followedId: string): void {
  emit(userRoom(followedId), "follow.new", { followerId })
}
