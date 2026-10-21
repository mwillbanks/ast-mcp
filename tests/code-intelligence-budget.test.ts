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
const startupTimeoutMs = 15_000;
async function deadline<T>(
  operation: Promise<T>,
  milliseconds = 4_000,
  phase = "MCP tool operation",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${phase} exceeded the independent ${milliseconds}ms deadline`,
              ),
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
        await deadline(
          client.connect(transport),
          startupTimeoutMs,
          "stdio initialization",
        );
      } else {
        const server = await spawnHttpMcpProcess(
          process.execPath,
          [path.join(repository, "bin/ast-mcp.ts"), "mcp"],
          { cwd: root, env },
        );
        stop = () => server.stop();
        await deadline(
          client.connect(new StreamableHTTPClientTransport(server.url)),
          startupTimeoutMs,
          "HTTP initialization",
        );
      }
      // The initialization response and discovery prove readiness before operational budgets begin.
      const available = await deadline(
        client.listTools(),
        4_000,
        "MCP tool discovery",
      );
      const names = available.tools.map((tool) => tool.name);
      for (const name of ["map", "impact", "file_hash", "file_delete"])
        expect(names).toContain(name);
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
        client.callTool({
          name: "impact",
          arguments: { paths: ["small.ts"] },
        }),
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

      // Reference preflight must reject safely and leave the transport usable.
      const source = path.join(root, "referenced.ts");
      await writeFile(source, "export const referenced = 1;\n");
      await writeFile(
        path.join(root, "importer.ts"),
        'import { referenced } from "./referenced";\nconsole.log(referenced);\n',
      );
      const sourceHash = await deadline(
        client.callTool({
          name: "file_hash",
          arguments: { filePaths: [source] },
        }),
      );
      const expectedSha256 = (
        sourceHash.structuredContent as {
          data: { files: Array<{ sha256: string }> };
        }
      ).data.files[0]!.sha256;
      const referenced = await deadline(
        client.callTool({
          name: "file_delete",
          arguments: { files: { [source]: { expectedSha256 } } },
        }),
      );
      expect(referenced.isError, JSON.stringify(referenced)).toBeTrue();
      expect(JSON.stringify(referenced)).toContain("referenced by");
      expect((await hash()).isError).not.toBeTrue();
      const deleted = await deadline(
        client.callTool({
          name: "file_delete",
          arguments: {
            files: { [source]: { expectedSha256, forceReferences: true } },
          },
        }),
      );
      expect(deleted.isError, JSON.stringify(deleted)).not.toBeTrue();
      expect(await Bun.file(source).exists()).toBeFalse();
      expect((await hash()).isError).not.toBeTrue();

      await writeFile(path.join(root, "heavy.ts"), heavy);
      await writeFile(source, "export const referenced = 1;\n");
      const deleteHeavy = (signal?: AbortSignal) =>
        client.callTool(
          {
            name: "file_delete",
            arguments: { files: { [source]: { expectedSha256 } } },
          },
          signal ? { signal } : undefined,
        );
      const unverified = deadline(deleteHeavy());
      await Bun.sleep(80);
      expect((await deadline(hash(), 1_500)).isError).not.toBeTrue();
      const incomplete = await unverified;
      expect(incomplete.isError).toBeTrue();
      expect(JSON.stringify(incomplete)).toContain(
        "reference_verification_failed",
      );
      expect(await Bun.file(source).exists()).toBeTrue();
      expect((await hash()).isError).not.toBeTrue();
      const deleteController = new AbortController();
      const cancelledDelete = deleteHeavy(deleteController.signal).then(
        () => false,
        () => true,
      );
      await Bun.sleep(80);
      deleteController.abort();
      expect(await deadline(cancelledDelete)).toBeTrue();
      expect(await Bun.file(source).exists()).toBeTrue();
      expect((await hash()).isError).not.toBeTrue();

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
  }, 35_000);
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
