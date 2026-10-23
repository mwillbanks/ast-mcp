import { expect, test } from "bun:test";

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import registerNativeCodeIntelligenceTools from "../../src/tools/code-intelligence";
import type { ConfiguredExecution } from "../../src/tools/configured";

test("native requests honor cancellation from the MCP request envelope during setup", async () => {
  const handlers = new Map<
    string,
    (input: unknown, context: ServerContext) => Promise<unknown>
  >();
  const server = {
    registerTool(
      name: string,
      _definition: unknown,
      handler: (input: unknown, context: ServerContext) => Promise<unknown>,
    ) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  const started = Promise.withResolvers<void>();
  const setup = Promise.withResolvers<never>();
  const execute = (async () => {
    started.resolve();
    return setup.promise;
  }) as ConfiguredExecution;
  registerNativeCodeIntelligenceTools(server, execute);
  const abort = new AbortController();
  const request = handlers.get("map")!({ timeout_ms: 2000 }, {
    mcpReq: { signal: abort.signal },
  } as ServerContext);
  await started.promise;
  abort.abort(new Error("caller cancelled"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      request,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Cancellation ignored during native setup")),
          1000,
        );
      }),
    ]);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "aborted" } },
    });
  } finally {
    clearTimeout(timer);
    setup.reject(new Error("test cleanup"));
    await request;
  }
});
