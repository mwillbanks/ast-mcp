import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import { toolFailure, toolSuccess } from "../../src/helpers/mcp-schema";
import {
  authorizeRequestedDecision,
  clearSessionApprovals,
  withApprovalContext,
} from "../../src/runtime/approval";
import { createServer } from "../../src/server";

async function fixture(timeoutMs: number, count = 1) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-approval-timeout-"),
  );
  await writeFile(path.join(root, "ast-mcp.toml"), "version = 2\n");
  await writeFile(path.join(root, "value.txt"), "responsive");
  const server = createServer(
    {},
    { globalEnabled: async () => false },
    {},
    {
      approvalTimeoutMs: timeoutMs,
    },
  );
  let mutations = 0;
  server.registerTool(
    "fixture_approval",
    {
      inputSchema: z.object({}),
    },
    async (_, context) => {
      try {
        return await withApprovalContext(
          { context, server, tool: "fixture_approval" },
          async () => {
            for (let index = 0; index < count; index += 1)
              authorizeRequestedDecision(
                {
                  canonicalPath: path.join(root, `requested-${index}`),
                  operation: "write",
                  policy: "request",
                  reason: "fixture approval",
                  ruleId: `fixture-${index}`,
                  source: "project",
                  specificity: 1,
                  symlinks: false,
                },
                1,
              );
            mutations += 1;
            return toolSuccess({ mutations });
          },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
  const client = new Client(
    { name: "approval-timeout-test", version: "1" },
    {
      capabilities: { elicitation: { form: {} }, roots: {} },
      supportedProtocolVersions: ["2025-11-25"],
    },
  );
  client.setRequestHandler("roots/list", async () => ({
    roots: [{ uri: Bun.pathToFileURL(root).href }],
  }));
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  return {
    client,
    server,
    root,
    mutations: () => mutations,
    connect: async () => {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
    },
    close: async () => {
      await client.close();
      await server.close();
      clearSessionApprovals();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("silent approval expires while reads and ping stay responsive and retries remain healthy", async () => {
  const instance = await fixture(200);
  const started = Promise.withResolvers<void>();
  let mode = "silent";
  instance.client.setRequestHandler("elicitation/create", async () => {
    if (mode === "silent") {
      started.resolve();
      return new Promise<never>(() => {});
    }
    return mode === "decline"
      ? { action: "decline" as const }
      : { action: "accept" as const, content: { decision: "allow_session" } };
  });
  try {
    await instance.connect();
    const pending = instance.client.callTool({
      name: "fixture_approval",
      arguments: {},
    });
    await started.promise;
    expect(await instance.client.ping()).toEqual({});
    const read = await instance.client.callTool({
      name: "file_read",
      arguments: {
        files: [
          { filePath: path.join(instance.root, "value.txt"), mode: "text" },
        ],
      },
    });
    expect(read.isError).not.toBe(true);
    expect(JSON.stringify(read)).toContain("responsive");
    expect((await pending).isError).toBe(true);
    expect(instance.mutations()).toBe(0);
    mode = "decline";
    const declined = await instance.client.callTool({
      name: "fixture_approval",
      arguments: {},
    });
    expect(declined.isError).toBe(true);
    expect(JSON.stringify(declined)).toContain("approval_denied");
    expect(instance.mutations()).toBe(0);
    mode = "accept";
    expect(
      (
        await instance.client.callTool({
          name: "fixture_approval",
          arguments: {},
        })
      ).isError,
    ).not.toBe(true);
    expect(instance.mutations()).toBe(1);
  } finally {
    await instance.close();
  }
});

test("progress notifications cannot extend the approval deadline", async () => {
  const instance = await fixture(50);
  let progress: ReturnType<typeof setInterval> | undefined;
  instance.client.setRequestHandler("elicitation/create", async (request) => {
    const progressToken = request.params._meta?.progressToken;
    expect(progressToken).toBeDefined();
    let value = 0;
    progress = setInterval(() => {
      void instance.client
        .notification({
          method: "notifications/progress",
          params: {
            progressToken: progressToken!,
            progress: ++value,
          },
        })
        .catch(() => {});
    }, 5);
    return new Promise<never>(() => {});
  });
  try {
    await instance.connect();
    const start = performance.now();
    const result = await instance.client.callTool({
      name: "fixture_approval",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(performance.now() - start).toBeLessThan(500);
    expect(instance.mutations()).toBe(0);
    expect(await instance.client.ping()).toEqual({});
  } finally {
    clearInterval(progress);
    await instance.close();
  }
});

test("cancelled approval cannot resume mutation after a late acceptance", async () => {
  const instance = await fixture(1000);
  const started = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<{
    action: "accept";
    content: { decision: string };
  }>();
  instance.client.setRequestHandler("elicitation/create", async () => {
    started.resolve();
    return answer.promise;
  });
  try {
    await instance.connect();
    const controller = new AbortController();
    const pending = instance.client.callTool(
      { name: "fixture_approval", arguments: {} },
      { signal: controller.signal },
    );
    await started.promise;
    controller.abort(new Error("cancelled by caller"));
    await expect(pending).rejects.toBeDefined();
    answer.resolve({
      action: "accept",
      content: { decision: "allow_session" },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await instance.client.ping()).toEqual({});
    expect(instance.mutations()).toBe(0);
  } finally {
    await instance.close();
  }
});

test("one batch can complete fifty distinct session approvals", async () => {
  const instance = await fixture(1000, 50);
  let prompts = 0;
  instance.client.setRequestHandler("elicitation/create", async () => {
    prompts += 1;
    return { action: "accept", content: { decision: "allow_session" } };
  });
  try {
    await instance.connect();
    const result = await instance.client.callTool({
      name: "fixture_approval",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(prompts).toBe(50);
    expect(instance.mutations()).toBe(1);
  } finally {
    await instance.close();
  }
});
