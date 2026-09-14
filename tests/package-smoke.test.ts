import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

async function command(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(args, { cwd, stderr: "pipe", stdout: "pipe" });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(`${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function drainOutput(
  stream: ReadableStream<Uint8Array>,
  chunks: string[],
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    chunks.push(decoder.decode(chunk, { stream: true }));
  }
  chunks.push(decoder.decode());
}

function capturedDiagnostics(stdout: string[], stderr: string[]): string {
  const output = [
    stdout.length > 0 ? `stdout:\n${stdout.join("").trim()}` : "",
    stderr.length > 0 ? `stderr:\n${stderr.join("").trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return output || "no server output";
}

async function connectHttpClient(
  url: URL,
  exitCode: () => number | null,
  diagnostics: () => string,
): Promise<Client> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const serverExitCode = exitCode();
    if (serverExitCode !== null) {
      throw new Error(
        `Packaged HTTP server exited with code ${serverExitCode}: ${diagnostics()}`,
      );
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const client = new Client({ name: "package-http-smoke", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(url), {
        timeout: Math.min(2_000, remainingMs),
      });
      return client;
    } catch (error) {
      lastError = error;
      await client.close().catch(() => undefined);
    }

    const backoffMs = Math.min(250, deadline - Date.now());
    if (backoffMs > 0) await Bun.sleep(backoffMs);
  }

  throw new Error(
    `Packaged HTTP server did not accept MCP initialize within 30 seconds: ${String(lastError)}\n${diagnostics()}`,
  );
}

function workspaceId(result: unknown): string {
  const match = JSON.stringify(result).match(/workspace:v1:[a-f0-9]{64}/);
  if (!match) throw new Error("workspace_open omitted workspaceId");
  return match[0];
}

function toolData<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  expect(
    result.isError,
    JSON.stringify(result.structuredContent),
  ).not.toBeTrue();
  const data = (result.structuredContent as { data?: T } | undefined)?.data;
  expect(data).toBeDefined();
  if (!data) throw new Error("Tool omitted structured data");
  return data;
}

async function exercisePackage(
  client: Client,
  fixture: string,
  storagePath: string,
  writable: string,
): Promise<void> {
  const opened = await client.callTool({
    arguments: {
      directory: fixture,
      storage: { kind: "explicit", path: storagePath },
    },
    name: "workspace_open",
  });
  const id = workspaceId(opened.structuredContent);
  const mapped = toolData<{
    files: Array<{ symbols: Array<{ name: string }> }>;
  }>(
    await client.callTool({
      arguments: { paths: ["entry.ts"], workspaceId: id },
      name: "map",
    }),
  );
  expect(
    mapped.files.flatMap((file) => file.symbols.map((symbol) => symbol.name)),
  ).toContain("publish");

  const built = toolData<{ generation: string }>(
    await client.callTool({
      arguments: { action: "build", workspaceId: id },
      name: "index",
    }),
  );
  expect(built.generation).toMatch(/^generation:v1:[a-f0-9]{64}$/);
  const status = toolData<{
    counts: Record<string, number>;
    generation: string | null;
  }>(
    await client.callTool({
      arguments: { timeoutMs: 30_000, workspaceId: id },
      name: "index_status",
    }),
  );
  expect(status.generation).toBe(built.generation);
  expect(status.counts.artifacts).toBeGreaterThan(0);
  expect(status.counts.chunks).toBeGreaterThan(0);
  expect(status.counts.publications).toBeGreaterThan(0);

  const retrieved = toolData<{ results: unknown[] }>(
    await client.callTool({
      arguments: {
        budget: {
          maxBytes: 64_000,
          maxCandidates: 100,
          maxItems: 20,
          timeoutMs: 30_000,
        },
        query: "publish",
        semantic: false,
        workspaceId: id,
      },
      name: "retrieve",
    }),
  );
  expect(retrieved.results.length).toBeGreaterThan(0);

  const hashed = toolData<{ files: Array<{ sha256: string }> }>(
    await client.callTool({
      arguments: { filePaths: [writable], workspaceId: id },
      name: "file_hash",
    }),
  );
  toolData(
    await client.callTool({
      arguments: {
        files: {
          [writable]: {
            aiderBlocks: [{ replace: "updated\n", search: "original\n" }],
            expectedSha256: hashed.files[0]?.sha256,
            patchStrategy: "aider_block",
          },
        },
        workspaceId: id,
      },
      name: "file_patch",
    }),
  );
  expect(await readFile(path.join(fixture, writable), "utf8")).toBe(
    "updated\n",
  );
}

function availablePort(): number {
  const probe = Bun.serve({ fetch: () => new Response("probe"), port: 0 });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("Bun did not allocate an HTTP port");
  return port;
}

test("extracted package supports stdio and HTTP lifecycle operations", async () => {
  const repository = path.resolve(import.meta.dir, "..");
  const owned = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-package-smoke-"));
  const fixture = path.join(owned, "fixture");
  try {
    await command(["bun", "run", "build"], repository);
    const packed = await command(
      [
        "bun",
        "pm",
        "pack",
        "--ignore-scripts",
        "--destination",
        owned,
        "--quiet",
      ],
      repository,
    );
    const archive = path.isAbsolute(packed)
      ? packed
      : path.join(owned, path.basename(packed));
    await command(["tar", "-xzf", archive, "-C", owned], repository);
    await command(["git", "init", "-q", fixture], repository);
    await Promise.all([
      writeFile(
        path.join(fixture, "entry.ts"),
        "export function publish(value: string) { return value; }\n",
      ),
      writeFile(
        path.join(fixture, "Main.java"),
        "public final class Main { public static void run() {} }\n",
      ),
      writeFile(path.join(fixture, "stdio.txt"), "original\n"),
      writeFile(path.join(fixture, "http.txt"), "original\n"),
    ]);
    await command(["git", "add", "."], fixture);
    await command(
      [
        "git",
        "-c",
        "user.email=package@example.invalid",
        "-c",
        "user.name=Package Smoke",
        "commit",
        "-qm",
        "fixture",
      ],
      fixture,
    );

    const executable = path.join(owned, "package", "dist", "ast-mcp.js");
    const stdio = new Client({ name: "package-stdio-smoke", version: "1" });
    const stdioTransport = new StdioClientTransport({
      args: [executable, "mcp"],
      command: process.execPath,
      cwd: fixture,
      stderr: "pipe",
    });
    await stdio.connect(stdioTransport);
    try {
      await exercisePackage(
        stdio,
        fixture,
        path.join(owned, "stdio-storage"),
        "stdio.txt",
      );
    } finally {
      await stdio.close();
    }

    const port = availablePort();
    const server = Bun.spawn(
      [
        process.execPath,
        executable,
        "mcp",
        "--transport",
        "http",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      { cwd: fixture, stderr: "pipe", stdout: "pipe" },
    );
    const serverStdout: string[] = [];
    const serverStderr: string[] = [];
    const stdoutDrain = drainOutput(server.stdout, serverStdout);
    const stderrDrain = drainOutput(server.stderr, serverStderr);
    try {
      const url = new URL(`http://127.0.0.1:${port}/mcp`);
      const http = await connectHttpClient(
        url,
        () => server.exitCode,
        () => capturedDiagnostics(serverStdout, serverStderr),
      );
      try {
        await exercisePackage(
          http,
          fixture,
          path.join(owned, "http-storage"),
          "http.txt",
        );
      } finally {
        await http.close();
      }
    } finally {
      if (server.exitCode === null) server.kill("SIGTERM");
      await server.exited;
      await Promise.all([stdoutDrain, stderrDrain]);
    }
  } finally {
    await rm(owned, { force: true, recursive: true });
  }
}, 180_000);
