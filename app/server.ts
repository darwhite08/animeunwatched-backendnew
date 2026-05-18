import http from "http";
import app from "./app";
import { env } from "./src/config/env";
import { initSocket } from "./src/realtime/socket";
import { setIo } from "./src/realtime/io-instance";
import { startJobs } from "./src/jobs";

const server = http.createServer(app);
const io = initSocket(server);
setIo(io);
startJobs();

server.listen(env.PORT, () => {
  console.log(`Server on http://localhost:${env.PORT}`);
});
