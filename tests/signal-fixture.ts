// fallow-ignore-file unused-file -- Spawned child-process entry point for signal lifecycle tests.
import { installProcessSignalHandlers } from "../src/runtime/signals";

installProcessSignalHandlers(async (signal) => {
  process.stderr.write(`closed:${signal}\n`);
  if (process.env.AST_MCP_TEST_PENDING_SHUTDOWN === "1")
    await new Promise(() => undefined);
});

process.stdout.write("ready\n");
setInterval(() => undefined, 60_000);
