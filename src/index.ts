import { createProcessServer as createServer } from "./lifecycle";
import { BatchingStdioServerTransport } from "./stdio";

const server = createServer();
const transport = new BatchingStdioServerTransport();

try {
  await server.connect(transport);
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
