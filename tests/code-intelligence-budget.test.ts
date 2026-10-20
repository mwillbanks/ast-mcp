import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import registerCodeIntelligence from "../src/tools/code-intelligence";
import { spawnHttpMcpProcess } from "./support/live-process";

const repository = path.resolve(import.meta.dir, "..");
async function deadline<T>(
  operation: Promise<T>,
  milliseconds = 4_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("MCP operation exceeded the independent deadline"),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
for (const transportKind of ["stdio", "http"] as const) {
  test(`${transportKind} intelligence validation, CPU deadlines, and cancellation preserve the connection`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-code-budget-"));
    const client = new Client({ name: "code-budget-test", version: "1" });
    let stop: (() => Promise<void>) | undefined;
    try {
      await writeFile(
        path.join(root, "small.ts"),
        "export function publish() { return receive(); }\nfunction receive() { return 1; }\n",
      );
      const heavy = Array.from(
        { length: 32_000 },
        (_, index) =>
          `export function item${index}() { return item${index + 1}(); }\n`,
      ).join("");
      expect(Buffer.byteLength(heavy)).toBeLessThan(2 * 1024 * 1024);
      await writeFile(path.join(root, "heavy.ts"), heavy);
      const env = {
        ...process.env,
        AST_MCP_PROJECT_ROOT: root,
        XDG_CONFIG_HOME: path.join(root, "config"),
        APPDATA: path.join(root, "config"),
      };
      if (transportKind === "stdio") {
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [path.join(repository, "bin/ast-mcp.ts"), "mcp"],
          cwd: root,
          env: env as Record<string, string>,
          stderr: "pipe",
        });
        await deadline(client.connect(transport));
      } else {
        const server = await spawnHttpMcpProcess(
          process.execPath,
          [path.join(repository, "bin/ast-mcp.ts"), "mcp"],
          { cwd: root, env },
        );
        stop = () => server.stop();
        await deadline(
          client.connect(new StreamableHTTPClientTransport(server.url)),
        );
      }
      const hash = () =>
        deadline(
          client.callTool({
            name: "file_hash",
            arguments: { filePaths: [path.join(root, "small.ts")] },
          }),
        );
      const invalid = await deadline(
        client.callTool({
          name: "impact",
          arguments: {
            file: path.join(repository, "src/installer.ts"),
            symbols: ["reconcile"],
            mode: "all",
            limit: 10,
            budget: 2_000,
            timeout_ms: 2_000,
          },
        }),
      );
      expect(invalid.isError).toBeTrue();
      expect((await hash()).isError).not.toBeTrue();
      const missing = await deadline(
        client.callTool({ name: "impact", arguments: { paths: ["small.ts"] } }),
      );
      expect(missing.isError).toBeTrue();
      expect(JSON.stringify(missing)).toContain("target");
      const valid = await deadline(
        client.callTool({
          name: "impact",
          arguments: {
            target: "publish",
            paths: ["small.ts"],
            timeout_ms: 2_000,
          },
        }),
      );
      expect(valid.isError, JSON.stringify(valid)).not.toBeTrue();
      expect(JSON.stringify(valid.structuredContent)).toContain("receive");

      const expensive = deadline(
        client.callTool({
          name: "map",
          arguments: { paths: ["heavy.ts"], timeout_ms: 200 },
        }),
      );
      await Bun.sleep(80);
      // A synchronous parser blocks this unrelated request until parsing finishes.
      expect((await deadline(hash(), 1_500)).isError).not.toBeTrue();
      const timedOut = await expensive;
      expect(timedOut.isError).toBeTrue();
      expect(JSON.stringify(timedOut.structuredContent)).toContain(
        '"code":"timeout"',
      );
      expect((await hash()).isError).not.toBeTrue();

      await writeFile(
        path.join(root, "oversized.ts"),
        " ".repeat(2 * 1024 * 1024 + 1),
      );
      const oversized = await deadline(
        client.callTool({
          name: "map",
          arguments: { paths: ["oversized.ts"] },
        }),
      );
      expect(oversized.isError).toBeTrue();
      expect(JSON.stringify(oversized.structuredContent)).toContain(
        "intelligence_budget_exceeded",
      );
      expect((await hash()).isError).not.toBeTrue();
      const structural = await deadline(
        client.callTool({
          name: "run",
          arguments: {
            paths: ["small.ts"],
            pattern: "return $VALUE",
            timeout_ms: 2_000,
          },
        }),
      );
      expect(structural.isError, JSON.stringify(structural)).not.toBeTrue();
      expect(JSON.stringify(structural.structuredContent)).toContain(
        "receive()",
      );

      await writeFile(
        path.join(root, "tsconfig.json"),
        " ".repeat(2 * 1024 * 1024 + 1),
      );
      const oversizedConfig = await deadline(
        client.callTool({
          name: "impact",
          arguments: { target: "publish", paths: ["small.ts"] },
        }),
      );
      expect(oversizedConfig.isError).toBeTrue();
      expect(JSON.stringify(oversizedConfig.structuredContent)).toContain(
        "intelligence_budget_exceeded",
      );
      expect((await hash()).isError).not.toBeTrue();

      const controller = new AbortController();
      const cancelled = client
        .callTool(
          {
            name: "map",
            arguments: { paths: ["heavy.ts"], timeout_ms: 5_000 },
          },
          { signal: controller.signal, timeout: 6_000 },
        )
        .then(
          () => false,
          () => true,
        );
      await Bun.sleep(80);
      controller.abort();
      expect(await deadline(cancelled)).toBeTrue();
      expect((await hash()).isError).not.toBeTrue();
      const recovered = await deadline(
        client.callTool({
          name: "map",
          arguments: { paths: ["small.ts"], timeout_ms: 2_000 },
        }),
      );
      expect(recovered.isError, JSON.stringify(recovered)).not.toBeTrue();
      expect(JSON.stringify(recovered.structuredContent)).toContain("publish");
    } finally {
      await client.close();
      await stop?.();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
}

test("inventory overflow fails explicitly before parsing and releases server resources", async () => {
  const handlers = new Map<
    string,
    (input: Record<string, unknown>, context: unknown) => Promise<unknown>
  >();
  const server = {
    close: async () => {},
    registerTool: (
      name: string,
      _schema: unknown,
      handler: (
        input: Record<string, unknown>,
        context: unknown,
      ) => Promise<unknown>,
    ) => handlers.set(name, handler),
  };
  registerCodeIntelligence(server as never);
  const scan = Bun.Glob.prototype.scan;
  try {
    Bun.Glob.prototype.scan = async function* () {
      for (let index = 0; index <= 100_000; index += 1)
        yield path.join(repository, `fake-${index}.ts`);
    } as never;
    const result = await deadline(
      handlers.get("map")!({ root: repository }, {}),
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "intelligence_budget_exceeded", retryable: true },
      },
    });
    expect(JSON.stringify(result)).toContain("narrower paths");
  } finally {
    Bun.Glob.prototype.scan = scan;
    await server.close();
  }
});

test("already cancelled setup and server close reject requests without orphaned failures", async () => {
  const handlers = new Map<
    string,
    (input: Record<string, unknown>, context: unknown) => Promise<unknown>
  >();
  const server = {
    close: async () => {},
    registerTool: (
      name: string,
      _schema: unknown,
      handler: (
        input: Record<string, unknown>,
        context: unknown,
      ) => Promise<unknown>,
    ) => handlers.set(name, handler),
  };
  registerCodeIntelligence(
    server as never,
    (async () => {
      await Bun.sleep(10);
      throw new Error("late setup rejection");
    }) as never,
  );
  const cancelled = await handlers.get("map")!(
    {},
    { signal: AbortSignal.abort() },
  );
  expect(cancelled).toMatchObject({
    isError: true,
    structuredContent: { error: { code: "aborted" } },
  });
  await Bun.sleep(30);
  const pending = handlers.get("map")!({}, {});
  await server.close();
  expect(await deadline(pending)).toMatchObject({
    isError: true,
    structuredContent: { error: { code: "aborted" } },
  });
  await Bun.sleep(30);
});
