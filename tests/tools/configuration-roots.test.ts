import { expect, test } from "bun:test";

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import registerConfigurationTools from "../../src/tools/configuration";
import type { ConfiguredExecution } from "../../src/tools/configured";
test("configuration status reuses bounded roots discovery even when the client advertises no roots", async () => {
  const handlers = new Map<
    string,
    (input: unknown, context: ServerContext) => Promise<unknown>
  >();
  let unboundedCalls = 0;
  const server = {
    server: {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: () => {
        unboundedCalls++;
        throw new Error("Duplicate roots discovery");
      },
    },
    registerTool: (
      name: string,
      _definition: unknown,
      handler: (input: unknown, context: ServerContext) => Promise<unknown>,
    ) => handlers.set(name, handler),
  } as unknown as McpServer;
  const execute = ((_input, operation) => operation()) as ConfiguredExecution;
  execute.clientRoots = async () => [];
  registerConfigurationTools(server, execute);
  const result = await handlers.get("config_status")!({}, {} as ServerContext);
  expect(result).not.toMatchObject({ isError: true });
  expect(unboundedCalls).toBe(0);
});
