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

// ── Room names ───────────────────────────────────────────────────────────────

export const FEED_ROOM            = "feed"
export const animeRoom    = (malId: number) => `anime:${malId}`
export const clubRoom     = (clubId: string) => `club:${clubId}`
export const threadRoom   = (threadId: string) => `thread:${threadId}`
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

export function broadcastPostDeleted(postId: string): void {
  emit(FEED_ROOM, "post.deleted", { postId })
}

// ── Anime events ─────────────────────────────────────────────────────────────

/** Someone added/removed/changed status on the anime — drives the live user-stats counters */
export function broadcastAnimeListChanged(malId: number): void {
  emit(animeRoom(malId), "anime.list-changed", { malId, at: Date.now() })
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
