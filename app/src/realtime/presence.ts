/**
 * In-memory presence + per-socket "focus" (which conversation a user is
 * actively viewing). Single-process only — no Redis. The DM service reads these
 * to decide deliveredAt, unread suppression, and online status; the Socket.IO
 * layer (Stage 3) populates them on connect/disconnect/focus.
 */

// userId -> set of connected socket ids
const onlineSockets = new Map<string, Set<string>>();
// socketId -> conversationId the user is currently viewing (or null)
const socketFocus = new Map<string, string | null>();
// socketId -> userId (reverse lookup for focus checks)
const socketUser = new Map<string, string>();
// userId -> last lastSeenAt write (throttle persistence to ≤1/min/user)
const lastSeenWrite = new Map<string, number>();

export function addSocket(userId: string, socketId: string): void {
  let set = onlineSockets.get(userId);
  if (!set) { set = new Set(); onlineSockets.set(userId, set); }
  set.add(socketId);
  socketUser.set(socketId, userId);
}

export function removeSocket(userId: string, socketId: string): void {
  onlineSockets.get(userId)?.delete(socketId);
  if (onlineSockets.get(userId)?.size === 0) onlineSockets.delete(userId);
  socketFocus.delete(socketId);
  socketUser.delete(socketId);
}

export function isOnline(userId: string): boolean {
  return (onlineSockets.get(userId)?.size ?? 0) > 0;
}

export function setFocus(socketId: string, conversationId: string | null): void {
  socketFocus.set(socketId, conversationId);
}

/** True if any of the user's sockets is currently viewing this conversation. */
export function isViewing(userId: string, conversationId: string): boolean {
  const sockets = onlineSockets.get(userId);
  if (!sockets) return false;
  for (const sid of sockets) {
    if (socketFocus.get(sid) === conversationId) return true;
  }
  return false;
}

/** Returns true at most once per minute per user — caller persists lastSeenAt. */
export function shouldPersistLastSeen(userId: string, now = Date.now()): boolean {
  const prev = lastSeenWrite.get(userId) ?? 0;
  if (now - prev < 60_000) return false;
  lastSeenWrite.set(userId, now);
  return true;
}
