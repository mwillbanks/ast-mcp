import {
  installProcessFailureHandlers,
  installProcessSignalHandlers,
} from "../runtime/signals";
import { createServer } from "./index";

export {
  createServer,
  installProcessFailureHandlers,
  installProcessSignalHandlers,
};

export function createProcessServer() {
  const server = createServer({}, {}, {}, { transport: "stdio" });
  const close = server.close.bind(server);
  let disposeSignals: (() => void) | undefined;
  let disposeFailures: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  server.close = () => {
    closing ??= Promise.resolve().then(async () => {
      const deadline = setTimeout(() => {
        process.stderr.write("ast-mcp connection shutdown timed out\n");
        process.exit(1);
      }, 5000);
      try {
        await close();
      } finally {
        clearTimeout(deadline);
        disposeSignals?.();
        disposeFailures?.();
      }
    });
    return closing;
  };
  disposeSignals = installProcessSignalHandlers(server.close.bind(server));
  disposeFailures = installProcessFailureHandlers(
    server.close.bind(server),
    process,
    5000,
    (error) => server.telemetry.reportException(error, true),
  );
  return server;
}
