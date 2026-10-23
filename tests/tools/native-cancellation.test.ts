import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";

import { withConfig } from "../../src/config";
import { withWorkspaceContext } from "../../src/intelligence/workspace/context.ts";
import { WorkspaceRegistry } from "../../src/intelligence/workspace/registry.ts";
import registerNativeCodeIntelligenceTools from "../../src/tools/code-intelligence";
import type { ConfiguredExecution } from "../../src/tools/configured";
import { hermeticConfig } from "../support/hermetic-config";

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

test("native inventories exclude reserved artifacts before reading working and revision sources", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "ast-native-reserved-artifacts-"),
  );
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", "-C", root, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(error);
    return output.trim();
  };
  try {
    await git("init", "-q");
    const ordinary = ["ordinary.ts", "nested/ordinary.ts"];
    const reserved = [
      "ast-mcp-locks/secret.ts",
      ".ast-mcp-locks/secret.ts",
      "nested/.ast-mcp-mutation-locks/secret.ts",
      "nested/ast-mcp-locks/secret.ts",
      "nested/guard.ast-mcp.lock.sqlite-wal",
      "nested/.ordinary.ts.ast-mcp.lock",
      "nested/.ordinary.ts.ast-mcp.lock.pending-7ec27d90-cbf1-4ccd-a75c-38fb8538b8da",
      "nested/.ordinary.ts.ast-mcp.lock.stale-5662e73f-c5bb-4e8c-90e2-57caf40dab7d",
    ];
    for (const name of [...ordinary, ...reserved]) {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        `export const ${reserved.includes(name) ? "reservedSecret" : "ordinaryCode"} = 1;\n`,
      );
    }
    await git("add", ".");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    const oid = await git("rev-parse", "HEAD");
    type Reply = {
      isError?: boolean;
      structuredContent?: {
        data?: {
          files?: Array<{ path: string }>;
          scan?: { candidates: number; parsed: number };
        };
      };
    };
    const handlers = new Map<
      string,
      (input: Record<string, unknown>, context: ServerContext) => Promise<Reply>
    >();
    registerNativeCodeIntelligenceTools(
      {
        registerTool(name: string, _definition: unknown, handler: never) {
          handlers.set(name, handler);
        },
      } as unknown as McpServer,
      async (_args, operation) => withConfig(hermeticConfig(root), operation),
    );
    const selections = [
      {
        input: { paths: ["ordinary.ts", ...reserved] },
        expected: ["ordinary.ts"],
      },
      {
        input: { paths: ["nested"], glob: "**/*" },
        expected: ["nested/ordinary.ts"],
      },
      { input: { glob: "**/*" }, expected: ordinary },
      { input: { paths: ["ast-mcp-locks"], glob: "**/*" }, expected: [] },
      { input: { file: reserved.at(-1) }, expected: [] },
    ];
    const check = async () => {
      for (const { input, expected } of selections) {
        const result = await handlers.get("map")!(
          { ...input, root, lang: "typescript" },
          {} as ServerContext,
        );
        expect(result.isError).not.toBe(true);
        expect(
          result.structuredContent?.data?.files
            ?.map((file) => file.path)
            .sort(),
        ).toEqual([...expected].sort());
        expect(result.structuredContent?.data?.scan).toMatchObject({
          candidates: expected.length,
          parsed: expected.length,
        });
      }
      const search = await handlers.get("search")!(
        { root, query: "ordinaryCode", glob: "**/*.ts" },
        {} as ServerContext,
      );
      expect(search.isError).not.toBe(true);
      expect(JSON.stringify(search.structuredContent)).toContain(
        "ordinaryCode",
      );
      expect(JSON.stringify(search.structuredContent)).not.toContain(
        "reservedSecret",
      );
    };
    await check();
    const registry = new WorkspaceRegistry();
    for (const revision of [
      { kind: "index" } as const,
      { kind: "commit", oid } as const,
    ]) {
      const workspace = await registry.open({
        configurationGeneration: 1,
        directory: root,
        revision,
      });
      await withWorkspaceContext(workspace, check);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
