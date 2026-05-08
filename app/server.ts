import http from "http";
import app from "./app";
import { env } from "./src/config/env";
import { initSocket } from "./src/realtime/socket";

const server = http.createServer(app);
initSocket(server);

server.listen(env.PORT, () => {
  console.log(`Server on http://localhost:${env.PORT}`);
});
