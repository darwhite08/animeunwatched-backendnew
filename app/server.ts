import http from "http";
import app from "./app";
import { env } from "./src/config/env";
import { initSocket } from "./src/realtime/socket";
import { startJobs } from "./src/jobs";

const server = http.createServer(app);
initSocket(server);
startJobs();

server.listen(env.PORT, () => {
  console.log(`Server on http://localhost:${env.PORT}`);
});
