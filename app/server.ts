import http from "http";
import app from "./app";
import { env } from "./src/config/env";
import { initSocket } from "./src/realtime/socket";
import { setIo } from "./src/realtime/io-instance";
import { startJobs } from "./src/jobs";
import { prisma } from "./src/config/prisma";

// Catch unhandled promise rejections so the process doesn't silently die
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
  if (env.NODE_ENV === "production") process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  if (env.NODE_ENV === "production") process.exit(1);
});

const server = http.createServer(app);

const io = initSocket(server);
setIo(io);
startJobs();

server.listen(env.PORT, () => {
  console.log(`[${env.NODE_ENV}] Server on http://localhost:${env.PORT}`);
});

// Graceful shutdown — give in-flight requests 10 s to complete
function shutdown(signal: string) {
  console.log(`[shutdown] Received ${signal}. Closing gracefully...`);
  server.close(async () => {
    await prisma.$disconnect().catch(console.error);
    console.log("[shutdown] Done.");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("[shutdown] Timed out — forcing exit.");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
