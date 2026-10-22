import { expect, spyOn, test } from "bun:test";

import type { McpServer } from "@modelcontextprotocol/server";

import { IntelligenceRuntime } from "../../src/intelligence/lifecycle/service.ts";
import {
  withWorkspaceContext,
  type WorkspaceHandle,
} from "../../src/intelligence/workspace/context.ts";
import type { ConfiguredExecution } from "../../src/tools/configured.ts";
import registerIntelligenceTools, {
  type IntelligenceToolService,
} from "../../src/tools/intelligence.ts";

type Handler = (
  input: Record<string, unknown>,
  context: unknown,
) => Promise<{ isError?: boolean; structuredContent?: unknown }>;

test("owned intelligence services close once even when server shutdown fails", async () => {
  for (const fail of [false, true]) {
    let serverCloses = 0;
    const runtimeClose = spyOn(IntelligenceRuntime.prototype, "close");
    const server = {
      registerTool() {},
      async close() {
        serverCloses++;
        if (fail) throw new Error("server shutdown failed");
      },
    } as unknown as McpServer;
    registerIntelligenceTools(server, (async (_input, operation) =>
      operation()) as ConfiguredExecution);
    try {
      const first = server.close();
      const second = server.close();
      expect(first).toBe(second);
      if (fail) await expect(first).rejects.toThrow("server shutdown failed");
      else await first;
      expect(serverCloses).toBe(1);
      expect(runtimeClose).toHaveBeenCalledTimes(1);
    } finally {
      runtimeClose.mockRestore();
    }
  }
});

test("generation and graph diff handlers preserve dependency failures", async () => {
  const workspace = {
    workspaceId: "workspace:v1:" + "a".repeat(64),
  } as WorkspaceHandle;
  for (const registryAvailable of [false, true]) {
    const handlers = new Map<string, Handler>();
    const server = {
      registerTool(name: string, _definition: unknown, handler: Handler) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    const execute = Object.assign(
      async <T>(_input: unknown, operation: () => Promise<T>) =>
        withWorkspaceContext(workspace, operation),
      registryAvailable
        ? { workspaceRegistry: { get: async () => workspace } }
        : {},
    ) as ConfiguredExecution;
    const service = new Proxy(
      {},
      {
        get: () => async () => {
          throw new Error("provider unavailable");
        },
      },
    ) as IntelligenceToolService;
    registerIntelligenceTools(server, execute, service);
    const diff = await handlers.get("graph_diff")!(
      {
        base: { workspaceId: workspace.workspaceId },
        target: { workspaceId: workspace.workspaceId },
      },
      {},
    );
    expect(diff.isError).toBe(true);
    expect(diff.structuredContent).toMatchObject({
      ok: false,
      error: {
        message: registryAvailable
          ? "provider unavailable"
          : "Workspace registry is unavailable",
      },
    });
    const generated = await handlers.get("generate")!(
      { workspaceId: workspace.workspaceId },
      {},
    );
    expect(generated.isError).toBe(true);
    expect(generated.structuredContent).toMatchObject({
      ok: false,
      error: { message: "provider unavailable" },
    });
  }
});
