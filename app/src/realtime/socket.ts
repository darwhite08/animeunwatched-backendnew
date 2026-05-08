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
