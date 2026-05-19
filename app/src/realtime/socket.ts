import { Server as SocketServer } from "socket.io";
import { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

export function initSocket(httpServer: HttpServer) {
  const io = new SocketServer(httpServer, {
    path: "/socket/v1",
    cors: {
      origin: (origin: string | undefined, callback: (err: Error | null, ok?: boolean) => void) => {
        if (!origin) { callback(null, true); return }
        const allowed = [env.CORS_ORIGIN, "http://localhost:3000", "http://localhost:3001", "http://localhost:3002"].filter(Boolean)
        if (allowed.includes(origin)) { callback(null, true); return }
        // Allow any local-network origin (phones on same WiFi)
        try {
          const { hostname } = new URL(origin)
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

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    socket.join(`user:${userId}`);

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
