import { Server as SocketServer } from "socket.io";
import { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { prisma } from "../config/prisma";

export function initSocket(httpServer: HttpServer) {
  const io = new SocketServer(httpServer, {
    path: "/socket/v1",
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
    if (!token) return next(new Error("unauthorized"));
    try {
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as { userId: string };
      socket.data.userId = payload.userId;
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

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    socket.join(`user:${userId}`);
    // Join the global feed channel so server can broadcast posts/reviews
    socket.join("feed");
    setOnline(userId);

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

    // Client opts in to anime / club / thread rooms when viewing those pages
    socket.on("room:join",  (room: string) => { if (typeof room === "string" && room.length < 64) socket.join(room) });
    socket.on("room:leave", (room: string) => { if (typeof room === "string" && room.length < 64) socket.leave(room) });

    socket.on("disconnect", () => { setOffline(userId) });

    // ── WebRTC call signaling ────────────────────────────────────────────────
    // The server is a pure relay — it never inspects SDP or ICE data.

    // Caller → server → recipient: incoming call notification
    socket.on("call:offer", (data: {
      to: string;
      offer: RTCSessionDescriptionInit;
      callType: "audio" | "video";
      callerName: string;
      callerAvatar: string | null;
    }) => {
      io.to(`user:${data.to}`).emit("call:incoming", {
        from:        userId,
        offer:       data.offer,
        callType:    data.callType,
        callerName:  data.callerName,
        callerAvatar: data.callerAvatar,
      });
    });

    // Recipient → server → caller: accepted, here's the answer SDP
    socket.on("call:answer", (data: { to: string; answer: RTCSessionDescriptionInit }) => {
      io.to(`user:${data.to}`).emit("call:answered", { answer: data.answer });
    });

    // Both sides → server → other side: ICE candidates
    socket.on("call:ice-candidate", (data: { to: string; candidate: RTCIceCandidateInit }) => {
      io.to(`user:${data.to}`).emit("call:ice-candidate", { candidate: data.candidate });
    });

    // Either side → server → other side: call ended
    socket.on("call:end", (data: { to: string }) => {
      io.to(`user:${data.to}`).emit("call:ended");
    });

    // Recipient → server → caller: call rejected
    socket.on("call:reject", (data: { to: string }) => {
      io.to(`user:${data.to}`).emit("call:rejected");
    });

    // Recipient → server → caller: already in another call
    socket.on("call:busy", (data: { to: string }) => {
      io.to(`user:${data.to}`).emit("call:busy");
    });

    // ── Typing indicators ────────────────────────────────────────────────────
    socket.on("typing:start", (data: { conversationId: string; to: string }) => {
      io.to(`user:${data.to}`).emit("typing:start", { from: userId, conversationId: data.conversationId });
    });

    socket.on("typing:stop", (data: { conversationId: string; to: string }) => {
      io.to(`user:${data.to}`).emit("typing:stop", { from: userId, conversationId: data.conversationId });
    });
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
