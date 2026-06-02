import http from "http";
import app from "./app";
import { env } from "./src/config/env";
import { initSocket } from "./src/realtime/socket";
import { setIo } from "./src/realtime/io-instance";
import { startJobs } from "./src/jobs";
import { prisma } from "./src/config/prisma";
import { getLiveSnapshot } from "./src/lib/realtimeAnalytics";
import { broadcastAdminAnalyticsLive } from "./src/realtime/broadcast";
import { ensureAdminSeed } from "./src/lib/adminSeed";
import { purgeExpiredStepUpTokens } from "./src/lib/stepup";
import { seedPiiInventory } from "./src/lib/piiScanner";

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

// Realtime analytics ticker — fires every 5 s; cheap (in-memory snapshot)
// and only sends to the `admin` socket room, so it's a no-op when no
// admins are connected.
setInterval(() => {
  try { broadcastAdminAnalyticsLive(getLiveSnapshot()) }
  catch (err) { console.error("[analytics-ticker] emit failed:", err) }
}, 5_000).unref();

// Admin RBAC seed — idempotent. Runs after `prisma db push` completes (CMD chain).
ensureAdminSeed()
  .then(() => console.log("[admin-seed] permissions + roles synced"))
  .catch((err: unknown) => console.error("[admin-seed] failed:", err));

// PII inventory seed — idempotent. Populates the GDPR Article 30 register on first boot.
seedPiiInventory()
  .then((r) => console.log(`[pii-seed] ${r.added} added, ${r.existing} existing`))
  .catch((err: unknown) => console.error("[pii-seed] failed:", err));

// Hourly cleanup of expired step-up tokens
setInterval(() => {
  purgeExpiredStepUpTokens().catch((err: unknown) =>
    console.error("[stepup-purge] failed:", err),
  );
}, 60 * 60 * 1000).unref();

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
