import { spawn } from "node:child_process";

export interface InstallerLaunch {
  args: string[];
  command: string;
  cwd?: string;
  windowsVerbatimArguments?: boolean;
}

const REQUIRED_TOOLS = [
  "file_read",
  "file_hash",
  "file_patch",
  "workspace_open",
];

export async function verifyMcpLaunch(
  launch: InstallerLaunch,
  timeoutMs = 15_000,
  shutdownTimeoutMs = 5000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let closing = false;
    let closingDeadline: ReturnType<typeof setTimeout> | undefined;
    let initialized = false;
    let buffer = "";
    let outputBytes = 0;
    let stderrTail = "";
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(closingDeadline);
      if (error) {
        child.kill("SIGKILL");
        reject(
          new Error(
            `${error.message}${stderrTail ? `\nStderr: ${stderrTail.trim()}` : ""}`,
          ),
        );
      } else {
        resolve();
      }
    };
    const deadline = setTimeout(
      () => finish(new Error("MCP launch verification timed out")),
      timeoutMs,
    );
    const beginShutdown = () => {
      if (closing || settled) return;
      closing = true;
      clearTimeout(deadline);
      closingDeadline = setTimeout(
        () => finish(new Error("MCP launch shutdown timed out")),
        shutdownTimeoutMs,
      );
      child.stdin.end();
    };
    const send = (message: unknown) => {
      if (!child.stdin.destroyed)
        child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    child.on("error", (error) =>
      finish(new Error(`MCP launch failed: ${error.message}`)),
    );
    child.on("close", (code, signal) => {
      if (settled) return;
      if (closing && code === 0 && signal === null) {
        finish();
      } else {
        finish(
          new Error(
            `MCP launch ${closing ? "shutdown failed" : "exited before tool discovery"} (code ${code}, signal ${signal})`,
          ),
        );
      }
    });
    child.stdin.on("error", (error) =>
      finish(new Error(`MCP launch input failed: ${error.message}`)),
    );
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8192);
      outputBytes += chunk.byteLength;
      if (outputBytes > 10 * 1024 * 1024)
        finish(new Error("MCP launch diagnostic output exceeded its limit"));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 10 * 1024 * 1024) {
        finish(new Error("MCP launch output exceeded its limit"));
        return;
      }
      if (closing) return;
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1 && !settled && !closing) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          try {
            const response = JSON.parse(line);
            if (response.id === 1) {
              if (
                response.error ||
                response.result?.serverInfo?.name !== "ast-mcp"
              )
                throw new Error(
                  "MCP launch did not initialize an ast-mcp server",
                );
              if (!initialized) {
                initialized = true;
                send({ jsonrpc: "2.0", method: "notifications/initialized" });
                send({
                  id: 2,
                  jsonrpc: "2.0",
                  method: "tools/list",
                  params: {},
                });
              }
            } else if (response.id === 2 && initialized) {
              const names = new Set(
                (response.result?.tools ?? []).map(
                  (tool: { name?: unknown }) => tool.name,
                ),
              );
              if (
                response.error ||
                !REQUIRED_TOOLS.every((name) => names.has(name))
              )
                throw new Error(
                  "MCP launch is missing required file or workspace tools",
                );
              beginShutdown();
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    send({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "ast-mcp-installer", version: "1" },
        protocolVersion: "2025-11-25",
      },
    });
  });
}
