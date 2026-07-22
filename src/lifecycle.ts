import { installProcessSignalHandlers } from "./runtime/signals";
import { createServer } from "./server";

export { createServer, installProcessSignalHandlers };

export function createProcessServer() {
  const server = createServer();
  installProcessSignalHandlers(server.close.bind(server));
  return server;
}
