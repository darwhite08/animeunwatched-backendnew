import { Server as SocketServer } from "socket.io";
import { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { prisma } from "../config/prisma";
import { addSocket, removeSocket, setFocus, shouldPersistLastSeen } from "./presence";
import { canSeeActivity } from "./activityGuard";
import { deliverUndelivered, persistLastSeen, markConversationRead, authorizeCall, isBlockedEitherWay } from "../modules/chat/chat.service";

export function initSocket(httpServer: HttpServer) {
  const io = new SocketServer(httpServer, {
    path: "/socket/v1",
    // Cap inbound frame size (default 1 MB). Socket events here carry small
    // JSON (SDP/ICE, room ids, conversation ids); 256 KB is generous and stops
    // a client from flooding multi-MB payloads through the relay handlers.
    maxHttpBufferSize: 256 * 1024,
    cors: {
      origin: (origin: string | undefined, callback: (err: Error | null, ok?: boolean) => void) => {
        if (!origin) { callback(null, true); return }
        const allowed = [env.CORS_ORIGIN, "http://localhost:3000", "http://localhost:3001", "http://localhost:3002"].filter(Boolean)
        if (allowed.includes(origin)) { callback(null, true); return }
        // Defensive: Capacitor bundled mode (iOS capacitor:// scheme). With
        // server.url the origin is already www.kaiveron.com (handled below).
        if (origin === "capacitor://localhost") { callback(null, true); return }
        try {
          const { hostname } = new URL(origin)
          // Any kaiveron.com subdomain (admin-dashboard, www, etc.)
          const isKaiveron = hostname === "kaiveron.com" || hostname.endsWith(".kaiveron.com")
          if (isKaiveron) { callback(null, true); return }
          // Local-network (phones on same WiFi)
          const isLan = /^192\.168\.\d+\.\d+$/.test(hostname) ||
            /^10\.\d+\.\d+\.\d+$/.test(hostname) ||
            /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)
          callback(null, isLan)
        } catch { callback(new Error("Not allowed")) }
      },
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    // No token → connect as an anonymous guest (watch-party invite links and
    // other public realtime). Guests are barred from every authenticated
    // subsystem in the connection handler below; they only get the public
    // room:join allowlist + watch-party handlers. A token that is PRESENT but
    // invalid/expired is still rejected, so the client's refresh-and-reconnect
    // flow keeps working instead of silently downgrading a real user to a guest.
    if (!token) {
      socket.data.userId = `guest_${socket.id}`;
      socket.data.anon = true;
      return next();
    }
    try {
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as { userId: string; exp?: number };
      socket.data.userId = payload.userId;
      socket.data.tokenExp = payload.exp; // seconds since epoch (for expiry enforcement)
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  // ── Presence tracking ──────────────────────────────────────────────────────
  // In-memory map: userId → number of active socket connections.
  // A user is "online" while count > 0. Multiple tabs/devices = multiple connections.
  const presenceCounts = new Map<string, number>();

  function broadcastOnlineCount() {
    io.emit("presence.count", { online: presenceCounts.size, at: Date.now() });
  }

  function setOnline(userId: string) {
    const next = (presenceCounts.get(userId) ?? 0) + 1;
    presenceCounts.set(userId, next);
    if (next === 1) {
      io.emit("presence.online", { userId, at: Date.now() });
      broadcastOnlineCount();
    }
  }

  function setOffline(userId: string) {
    const next = Math.max(0, (presenceCounts.get(userId) ?? 1) - 1);
    if (next === 0) {
      presenceCounts.delete(userId);
      io.emit("presence.offline", { userId, at: Date.now() });
      broadcastOnlineCount();
    } else {
      presenceCounts.set(userId, next);
    }
  }

  // Expose presence list lookup on the io instance for HTTP handlers
  (io as unknown as { getOnlineUsers: () => string[]; getOnlineCount: () => number }).getOnlineUsers = () =>
    Array.from(presenceCounts.keys());
  (io as unknown as { getOnlineUsers: () => string[]; getOnlineCount: () => number }).getOnlineCount = () =>
    presenceCounts.size;

  // ── Watch Party in-memory room state ──────────────────────────────────────
  // Best-effort synced playback. Host drives; server stores latest state and
  // replays to late joiners. Resets if the server restarts (acceptable for v1).
  type WpState = { hostId: string; videoId: string | null; playing: boolean; time: number; at: number };
  const wpRooms = new Map<string, WpState>();
  const WP_ROOM = /^wp:[a-zA-Z0-9_-]{4,48}$/;

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    const anon = socket.data.anon === true;

    // Anonymous guests skip every authenticated subsystem below — no per-user
    // DM stream, presence, undelivered-DM flush, admin room, or online snapshot.
    // They still get the public room:join allowlist + watch-party handlers wired
    // up further down. This keeps guests out of presence/DM bookkeeping entirely.
    if (!anon) {
      socket.join(`user:${userId}`);

      // Enforce access-token expiry on the live socket: a long-lived connection
      // must not outlive its token. Disconnect at exp; the client reconnects with
      // a freshly-refreshed token (frontend re-emits token after refresh). Without
      // this, a socket opened with a stolen token keeps realtime access forever.
      const expSec = socket.data.tokenExp as number | undefined;
      if (expSec) {
        const msLeft = expSec * 1000 - Date.now();
        const t = setTimeout(() => { try { socket.disconnect(true); } catch { /* noop */ } },
          Math.max(0, Math.min(msLeft, 2_147_483_000)));
        socket.on("disconnect", () => clearTimeout(t));
      }
      // Join the global feed channel so server can broadcast posts/reviews
      socket.join("feed");
      setOnline(userId);
      // DM v2 presence (per-socket online + focus tracking for the chat service).
      addSocket(userId, socket.id);

      // Batch-deliver any messages that arrived while this user was offline, then
      // emit a delivery receipt to each sender (spec §4 connect behavior).
      void deliverUndelivered(userId).then((receipts) => {
        for (const r of receipts) {
          io.to(`user:${r.senderId}`).emit("chat.delivered", {
            conversationId: r.conversationId, messageId: r.id, deliveredAt: r.deliveredAt,
          });
        }
      }).catch(() => {});

      // ── Admin room ──────────────────────────────────────────────────────────
      // ADMIN-role users auto-join `admin` so they get live updates of signups,
      // reports, audit events, etc. Lookup is async — done outside the main
      // connection handler critical path. Other handlers don't depend on it.
      void prisma.user.findUnique({
        where:  { id: userId },
        select: { role: true },
      }).then((u) => {
        if (u?.role === "ADMIN") {
          socket.join("admin")
          socket.data.role = "ADMIN"
        }
      }).catch((err) => {
        console.error("[socket] admin role lookup failed for user", userId, err)
      })

      // Snapshot of who is currently online (for status indicators) + total count
      socket.emit("presence.snapshot", { online: Array.from(presenceCounts.keys()) });
      socket.emit("presence.count", { online: presenceCounts.size, at: Date.now() });
    }

    // Client opts in to PUBLIC content rooms when viewing those pages. Only an
    // allowlist of public prefixes is joinable — never `user:` (per-user DM /
    // notification stream) or `admin` (privileged event stream), which would
    // otherwise let any authenticated client eavesdrop by guessing an id.
    // `user:<self>` is already auto-joined on connect; `admin` is server-joined
    // after a role check. Legitimate clients only ever join anime/post/thread/feed.
    const JOINABLE = /^(anime:[0-9]+|post:[a-z0-9]+|thread:[a-z0-9]+|blog:[a-z0-9-]+|feed)$/i;
    socket.on("room:join",  (room: string) => { if (typeof room === "string" && JOINABLE.test(room)) socket.join(room) });
    socket.on("room:leave", (room: string) => { if (typeof room === "string" && JOINABLE.test(room)) socket.leave(room) });

    // ── Watch Party ───────────────────────────────────────────────────────
    const wpCount = (room: string) => io.sockets.adapter.rooms.get(room)?.size ?? 0;
    socket.on("wp:join", (room: string) => {
      if (typeof room !== "string" || !WP_ROOM.test(room)) return;
      socket.join(room);
      if (!wpRooms.has(room)) wpRooms.set(room, { hostId: userId, videoId: null, playing: false, time: 0, at: Date.now() });
      const cur = wpRooms.get(room)!;
      socket.emit("wp:state", { ...cur, youAreHost: cur.hostId === userId });
      io.to(room).emit("wp:presence", { count: wpCount(room) });
    });
    socket.on("wp:sync", (d: { room: string; videoId?: string | null; playing?: boolean; time?: number }) => {
      if (typeof d?.room !== "string" || !WP_ROOM.test(d.room)) return;
      const cur = wpRooms.get(d.room);
      if (!cur || cur.hostId !== userId) return; // only the host drives playback
      if (typeof d.videoId === "string") cur.videoId = d.videoId;
      if (typeof d.playing === "boolean") cur.playing = d.playing;
      if (typeof d.time === "number") cur.time = d.time;
      cur.at = Date.now();
      socket.to(d.room).emit("wp:state", { ...cur });
    });
    socket.on("wp:chat", (d: { room: string; text: string; name?: string }) => {
      if (typeof d?.room !== "string" || !WP_ROOM.test(d.room)) return;
      const text = String(d?.text ?? "").slice(0, 500).trim();
      if (!text) return;
      io.to(d.room).emit("wp:chat", { userId, name: String(d?.name ?? "").slice(0, 40), text, at: Date.now() });
    });
    socket.on("wp:leave", (room: string) => {
      if (typeof room === "string" && WP_ROOM.test(room)) { socket.leave(room); io.to(room).emit("wp:presence", { count: wpCount(room) }); }
    });
    // On disconnect: if the host leaves a party, hand the room to another member.
    socket.on("disconnecting", () => {
      for (const room of socket.rooms) {
        if (!WP_ROOM.test(room)) continue;
        const cur = wpRooms.get(room);
        const remaining = (io.sockets.adapter.rooms.get(room)?.size ?? 1) - 1;
        if (remaining <= 0) { wpRooms.delete(room); continue; }
        io.to(room).emit("wp:presence", { count: remaining });
        if (cur && cur.hostId === userId) {
          const others = io.sockets.adapter.rooms.get(room);
          for (const sid of others ?? []) {
            if (sid === socket.id) continue;
            const newHostId = io.sockets.sockets.get(sid)?.data?.userId as string | undefined;
            if (newHostId) { cur.hostId = newHostId; cur.at = Date.now(); io.to(room).emit("wp:state", { ...cur }); break; }
          }
        }
      }
    });

    socket.on("disconnect", () => {
      if (anon) return; // guests were never added to presence/DM bookkeeping
      setOffline(userId);
      removeSocket(userId, socket.id);
      // Persist last-seen at most once/min/user (spec §4).
      if (shouldPersistLastSeen(userId)) void persistLastSeen(userId).catch(() => {});
    });

    // ── DM focus: which conversation this socket is actively viewing ───────────
    // Suppresses unread increments and auto-reads incoming messages (spec §4).
    socket.on("chat.focus", (data: { conversationId: string | null }) => {
      const cid = typeof data?.conversationId === "string" ? data.conversationId : null;
      setFocus(socket.id, cid);
      if (cid) void markConversationRead(cid, userId).catch(() => {});
    });

    // ── DM read receipt via socket (mirrors PATCH .../read) ───────────────────
    socket.on("chat.read", (data: { conversationId: string }) => {
      if (typeof data?.conversationId === "string") {
        void markConversationRead(data.conversationId, userId).catch(() => {});
      }
    });

    // ── WebRTC call signaling ────────────────────────────────────────────────
    // The server is a pure relay for SDP/ICE — but it authorizes every signal:
    // a conversation must exist between the two users and neither may have
    // blocked the other. Without this, any authenticated client could ring or
    // flood any user by guessing an id, and spoof the caller name/avatar.
    const validTo = (data: unknown): string | null =>
      data && typeof (data as { to?: unknown }).to === "string" ? (data as { to: string }).to : null;

    // Lightweight per-socket throttle on call:offer (anti-ring-spam).
    let lastOfferAt = 0;

    // Caller → server → recipient: incoming call notification. Caller identity
    // is derived server-side, never taken from the client payload.
    socket.on("call:offer", (data: {
      to: string;
      offer: RTCSessionDescriptionInit;
      callType: "audio" | "video";
    }) => {
      const to = validTo(data);
      if (!to) return;
      const now = Date.now();
      if (now - lastOfferAt < 2000) return; // ≤1 offer / 2s / socket
      lastOfferAt = now;
      void authorizeCall(userId, to).then((caller) => {
        if (!caller) return; // no conversation or blocked → silently drop
        io.to(`user:${to}`).emit("call:incoming", {
          from:        userId,
          offer:       data.offer,
          callType:    data.callType === "video" ? "video" : "audio",
          callerName:  caller.name,
          callerAvatar: caller.avatar,
        });
      }).catch(() => {});
    });

    // Relay the remaining signals only when not blocked either way. (These
    // follow an authorized offer, so a full conversation re-check isn't needed;
    // the block check prevents continuing a call across a fresh block.)
    const relayIfAllowed = (to: string | null, emit: () => void) => {
      if (!to) return;
      void isBlockedEitherWay(userId, to).then((blocked) => { if (!blocked) emit(); }).catch(() => {});
    };

    socket.on("call:answer", (data: { to: string; answer: RTCSessionDescriptionInit }) => {
      const to = validTo(data);
      relayIfAllowed(to, () => io.to(`user:${to}`).emit("call:answered", { answer: data.answer }));
    });
    socket.on("call:ice-candidate", (data: { to: string; candidate: RTCIceCandidateInit }) => {
      const to = validTo(data);
      relayIfAllowed(to, () => io.to(`user:${to}`).emit("call:ice-candidate", { candidate: data.candidate }));
    });
    socket.on("call:end", (data: { to: string }) => {
      const to = validTo(data);
      if (to) io.to(`user:${to}`).emit("call:ended"); // ending is always allowed (hangup)
    });
    socket.on("call:reject", (data: { to: string }) => {
      const to = validTo(data);
      if (to) io.to(`user:${to}`).emit("call:rejected");
    });
    socket.on("call:busy", (data: { to: string }) => {
      const to = validTo(data);
      if (to) io.to(`user:${to}`).emit("call:busy");
    });

    // ── Typing indicators ────────────────────────────────────────────────────
    // Relayed only when the recipient may see the sender's activity (block +
    // privacy via canSeeActivity), and throttled to ≤1 emit/sec/conversation.
    const typingThrottle = new Map<string, number>();
    function relayTyping(kind: "typing:start" | "typing:stop", data: { conversationId: string; to: string }) {
      if (!data?.to || typeof data.conversationId !== "string") return;
      const now = Date.now();
      const last = typingThrottle.get(data.conversationId) ?? 0;
      if (kind === "typing:start" && now - last < 1000) return;
      typingThrottle.set(data.conversationId, now);
      // recipient (data.to) is the viewer; sender (userId) is the target.
      void canSeeActivity(data.to, userId, "showOnlineStatus").then((ok) => {
        if (ok) io.to(`user:${data.to}`).emit(kind, { from: userId, conversationId: data.conversationId });
      }).catch(() => {});
    }
    socket.on("typing:start", (data: { conversationId: string; to: string }) => relayTyping("typing:start", data));
    socket.on("typing:stop",  (data: { conversationId: string; to: string }) => relayTyping("typing:stop", data));
  });

  return io;
}

export function emitToUser(
  io: SocketServer,
  userId: string,
  event: string,
  payload: unknown,
) {
  io.to(`user:${userId}`).emit(event, payload);
}
