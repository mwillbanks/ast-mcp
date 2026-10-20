import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createProcessServer as createServer } from "./lifecycle";
import { BatchingStdioServerTransport } from "./stdio";

const transport = new BatchingStdioServerTransport();
const start = transport.start.bind(transport);
let resolveStarted!: () => void;
let rejectStarted!: (error: unknown) => void;
const started = new Promise<void>((resolve, reject) => {
  resolveStarted = resolve;
  rejectStarted = reject;
});
transport.start = async () => {
  try {
    await start();
    resolveStarted();
  } catch (error) {
    rejectStarted(error);
    throw error;
  }
};
const server = serveStdio(() => createServer(), {
  transport,
  onerror: (error) =>
    process.stderr.write(
      `ast-mcp transport: ${error.message.slice(0, 2000)}\n`,
    ),
});

try {
  await started;
} catch (error) {
  process.stderr.write(
    `ast-mcp startup failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
  const deadline = setTimeout(() => process.exit(1), 5000);
  try {
    await server.close();
  } catch (closeError) {
    process.stderr.write(
      `ast-mcp startup cleanup failed: ${closeError instanceof Error ? closeError.message : String(closeError)}\n`,
    );
  } finally {
    clearTimeout(deadline);
    process.exitCode = 1;
  }
}
