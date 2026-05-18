import { Server as SocketServer } from "socket.io";
import { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

export function initSocket(httpServer: HttpServer) {
  const io = new SocketServer(httpServer, {
    path: "/socket/v1",
    cors: { origin: env.CORS_ORIGIN, credentials: true },
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
