import { expect, test } from "bun:test";
import { type CliHandlers, runCli } from "../src/cli";

function handlers(mcp: CliHandlers["mcp"]) {
  const stderr: string[] = [];
  const value: CliHandlers = {
    config: async () => {},
    hook: async () => 0,
    installer: async () => {},
    mcp,
    stderr: (text) => stderr.push(text),
    stdout: () => {},
  };
  return { stderr, value };
}

test("renders MCP usage errors with transport help", async () => {
  const { stderr, value } = handlers(async () => {
    const error = new Error("Invalid transport");
    error.name = "McpUsageError";
    throw error;
  });
  expect(await runCli(["mcp", "--transport", "invalid"], value)).toBe(1);
  expect(stderr[0]).toContain("Invalid transport");
  expect(stderr[0]).toContain("--transport <mode>");
});

test("does not swallow unexpected MCP runtime failures", async () => {
  const { value } = handlers(async () => {
    throw new Error("runtime failed");
  });
  await expect(runCli(["mcp"], value)).rejects.toThrow("runtime failed");
});
