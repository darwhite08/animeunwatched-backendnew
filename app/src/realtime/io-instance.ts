import { Server as SocketServer } from "socket.io";

let _io: SocketServer | null = null;

export function setIo(io: SocketServer): void {
  _io = io;
}

export function getIo(): SocketServer | null {
  return _io;
}
