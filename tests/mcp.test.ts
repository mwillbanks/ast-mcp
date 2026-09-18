import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const NATIVE_CODE_TOOLS = [
  "callees",
  "callers",
  "context",
  "cycles",
  "deps",
  "digest",
  "find_related",
  "graph",
  "impact",
  "implements",
  "map",
  "reverse_deps",
  "run",
  "search",
  "show",
  "squeeze",
  "surface",
  "trace",
] as const;

function expectedToolNames() {
  return [
    ...NATIVE_CODE_TOOLS,
    "config_core",
    "config_paths",
    "config_status",
    "document_query",
    "file_capabilities",
    "file_chattr",
    "file_delete",
    "file_hash",
    "file_patch",
    "file_read",
    "file_rename",
    "file_write",
    "generate",
    "graph_diff",
    "graph_explain",
    "graph_path",
    "graph_query",
    "index",
    "index_status",
    "policy_check",
    "retrieve",
    "workspace_open",
    "workspace_status",
  ].sort();
}

function toolProperties(
  tools: Array<{ inputSchema?: unknown; name: string }>,
  name: string,
) {
  const schema = tools.find((tool) => tool.name === name)?.inputSchema as
    | { properties?: Record<string, unknown> }
    | undefined;
  return schema?.properties;
}

async function git(directory: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  ) as Record<string, string>;
  Object.assign(env, {
    GIT_AUTHOR_EMAIL: "ast-mcp@example.test",
    GIT_AUTHOR_NAME: "AST MCP",
    GIT_COMMITTER_EMAIL: "ast-mcp@example.test",
    GIT_COMMITTER_NAME: "AST MCP",
    GIT_OPTIONAL_LOCKS: "0",
  });
  const child = Bun.spawn(["git", "-C", directory, ...args], {
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function withStdioTools(
  run: (
    tools: Array<{ description?: string; inputSchema?: unknown; name: string }>,
  ) => void,
) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: [path.resolve(import.meta.dir, "../src/index.ts")],
    command: "bun",
    cwd: path.resolve(import.meta.dir, ".."),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    run((await client.listTools()).tools);
  } finally {
    await client.close();
  }
}

test("stdio server exposes only ast-mcp tools", async () => {
  await withStdioTools((tools) => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(expectedToolNames());
  });
});

test("stdio tool schemas expose batched file and map contracts", async () => {
  await withStdioTools((tools) => {
    const run = tools.find((tool) => tool.name === "run");
    expect(run?.description).toContain(
      "write=true is disabled; commit through file_patch",
    );
    expect(toolProperties(tools, "run")?.pattern).toBeTruthy();
    expect(
      (toolProperties(tools, "map") as { detail?: { enum?: string[] } })?.detail
        ?.enum,
    ).toEqual(["names", "signatures", "full"]);
    expect(toolProperties(tools, "file_read")?.files).toBeTruthy();
    expect(toolProperties(tools, "file_read")?.filePath).toBeUndefined();
    expect(toolProperties(tools, "file_hash")?.filePaths).toBeTruthy();
    expect(toolProperties(tools, "file_read")?.workspaceId).toBeTruthy();
    expect(toolProperties(tools, "file_read")?.revision).toBeTruthy();
    expect(toolProperties(tools, "file_rename")?.workspaceId).toBeTruthy();
    expect(toolProperties(tools, "workspace_open")?.directory).toBeTruthy();
    expect(toolProperties(tools, "workspace_open")?.storage).toBeTruthy();
  });
});

test("CLI mcp subcommand remains alive for a stdio handshake", async () => {
  const client = new Client({ name: "cli-test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: [path.resolve(import.meta.dir, "../bin/ast-mcp.ts"), "mcp"],
    command: "bun",
    cwd: path.resolve(import.meta.dir, ".."),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  } finally {
    await client.close();
  }
});

test("calls native code intelligence through the server", async () => {
  const client = new Client({ name: "native-code-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: [path.resolve(import.meta.dir, "../src/index.ts")],
    command: "bun",
    cwd: path.resolve(import.meta.dir, ".."),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const root = path.resolve(import.meta.dir, "..");
    const opened = await client.callTool({
      arguments: { directory: root },
      name: "workspace_open",
    });
    expect(opened.isError).not.toBeTrue();
    const openedText = JSON.stringify(opened.structuredContent);
    expect(openedText).toContain(`"checkoutRoot":${JSON.stringify(root)}`);
    const workspaceId = openedText.match(/workspace:v1:[a-f0-9]{64}/)?.[0];
    expect(workspaceId).toBeDefined();
    if (!workspaceId) throw new Error("workspace_open omitted workspaceId");
    const result = await client.callTool({
      arguments: { paths: ["src/server.ts"], workspaceId },
      name: "map",
    });
    expect(result.isError).not.toBeTrue();
    expect(JSON.stringify(result.structuredContent)).toContain("createServer");
    const coverageResult = await client.callTool({
      arguments: {
        limit: 1,
        paths: ["tests/fixtures/intelligence/scan"],
        scan_limit: 3,
        workspaceId,
      },
      name: "map",
    });
    expect(coverageResult.isError).not.toBeTrue();
    const coverage = coverageResult.structuredContent as {
      data: {
        generation: string | null;
        repository: string;
        revision: string;
        scan: {
          candidates: number;
          eligible: number;
          omitted: {
            scanLimit: number;
            unreadable: number;
            unsupported: number;
          };
          parsed: number;
          paths: { scanLimit: string[] };
          truncated: boolean;
        };
        truncated: boolean;
        workspace: string;
      };
    };
    expect(coverage.data.scan).toMatchObject({
      candidates: 6,
      eligible: 6,
      omitted: {
        scanLimit: 3,
        unreadable: 0,
        unsupported: 0,
      },
      parsed: 3,
      paths: {
        scanLimit: [
          "tests/fixtures/intelligence/scan/module.mts",
          "tests/fixtures/intelligence/scan/page.htm",
          "tests/fixtures/intelligence/scan/page.html",
        ],
      },
      truncated: true,
    });
    expect(coverage.data.truncated).toBeTrue();
    expect(coverage.data.workspace).toBe(workspaceId);
    expect(coverage.data.repository).toMatch(/^repository:v1:[a-f0-9]{64}$/);
    expect(coverage.data.revision).toMatch(/^revision:v1:[a-f0-9]{64}$/);
    expect(coverage.data).toHaveProperty("generation");
    const write = await client.callTool({
      arguments: { pattern: "__AST_MCP_NO_MATCH__", write: true },
      name: "run",
    });
    expect(write.isError).toBeTrue();
    expect(JSON.stringify(write.structuredContent)).toContain("file_patch");
  } finally {
    await client.close();
  }
}, 30_000);

test("revision native tools ignore dirty and untracked files", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-native-revision-"),
  );
  await git(root, ["init", "-b", "main"]);
  await writeFile(
    path.join(root, "historical.ts"),
    "export const historicalOnly = 1;\n",
  );
  await git(root, ["add", "historical.ts"]);
  await git(root, ["commit", "-m", "base"]);
  const commit = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["tag", "v1", commit]);
  await writeFile(
    path.join(root, "historical.ts"),
    "export const dirtyOnly = 2;\n",
  );
  await writeFile(
    path.join(root, "untracked.ts"),
    "export const untrackedOnly = 3;\n",
  );

  const client = new Client({
    name: "historical-native-test",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    args: [path.resolve(import.meta.dir, "../src/index.ts")],
    command: "bun",
    cwd: root,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    for (const revision of [
      { kind: "commit" as const, oid: commit },
      { kind: "index" as const },
      { kind: "branch" as const, name: "main" },
      { kind: "tag" as const, name: "v1" },
    ]) {
      const opened = await client.callTool({
        arguments: { directory: root, revision },
        name: "workspace_open",
      });
      expect(opened.isError).not.toBeTrue();
      const workspaceId = (
        opened.structuredContent as {
          data?: { workspace?: { workspaceId?: string } };
        }
      ).data?.workspace?.workspaceId;
      expect(workspaceId).toStartWith("workspace:v1:");
      if (!workspaceId) throw new Error("workspace_open omitted workspaceId");

      const mapped = await client.callTool({
        arguments: { workspaceId },
        name: "map",
      });
      expect(mapped.isError).not.toBeTrue();
      const data = (
        mapped.structuredContent as {
          data: {
            files: Array<{ path: string; symbols: Array<{ name: string }> }>;
            generation: string | null;
            repository: string;
            revision: string;
            scan: {
              candidates: number;
              omitted: number;
              parsed: number;
              truncated: boolean;
            };
            truncated: boolean;
            workspace: string;
          };
        }
      ).data;
      expect(data.files.map((file) => file.path)).toEqual(["historical.ts"]);
      expect(
        data.files.flatMap((file) => file.symbols.map((item) => item.name)),
      ).toContain("historicalOnly");
      expect(JSON.stringify(data)).not.toContain("dirtyOnly");
      expect(JSON.stringify(data)).not.toContain("untrackedOnly");
      expect(data.scan).toMatchObject({
        candidates: 1,
        omitted: 0,
        parsed: 1,
        truncated: false,
      });
      expect(data.truncated).toBeFalse();
      expect(data.workspace).toBe(workspaceId);
      expect(data.repository).toMatch(/^repository:v1:[a-f0-9]{64}$/);
      expect(data.revision).toMatch(/^revision:v1:[a-f0-9]{64}$/);
      expect(data).toHaveProperty("generation");
    }
  } finally {
    await client.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("negotiates sampling before the first generate tool call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-sampling-"));
  await mkdir(path.join(root, ".git"));
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    `version = 2

[intelligence.generation]
enabled = true

[intelligence.generation.provider]
kind = "mcp"
server_id = "host"
model = "fixture/model"
`,
  );
  await writeFile(path.join(root, "sample.ts"), "export const sample = 1;\n");
  const client = new Client(
    { name: "sampling-client", version: "1.0.0" },
    { capabilities: { sampling: {} } },
  );
  let samplingCalls = 0;
  client.setRequestHandler("sampling/createMessage", async (request) => {
    samplingCalls += 1;
    expect(request.params.modelPreferences?.hints?.[0]?.name).toBe(
      "fixture/model",
    );
    return {
      content: {
        text: JSON.stringify({
          answer: "Supported.",
          citations: [{ end: 9, evidenceId: "entity-1", start: 0 }],
        }),
        type: "text" as const,
      },
      model: "fixture/model",
      role: "assistant" as const,
    };
  });
  const transport = new StdioClientTransport({
    args: [path.resolve(import.meta.dir, "../src/index.ts")],
    command: "bun",
    cwd: root,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const opened = await client.callTool({
      arguments: { directory: root },
      name: "workspace_open",
    });
    const workspaceId = (
      opened.structuredContent as {
        data?: { workspace?: { workspaceId?: string } };
      }
    ).data?.workspace?.workspaceId;
    expect(workspaceId).toStartWith("workspace:v1:");
    const indexed = await client.callTool({
      arguments: { action: "build", workspaceId },
      name: "index",
    });
    expect(indexed.isError).not.toBeTrue();
    const generationArguments = {
      allowedCorpusArtifactIds: ["artifact-1"],
      evidence: [
        {
          artifactId: "artifact-1",
          entityId: "entity-1",
          path: "sample.ts",
          range: {
            end: { column: 9, line: 0 },
            endByte: 9,
            start: { column: 0, line: 0 },
            startByte: 0,
          },
          text: "Supported",
        },
      ],
      prompt: "Answer from evidence",
      workspaceId,
    };
    const controller = new AbortController();
    const cancelled = client.callTool(
      { arguments: generationArguments, name: "generate" },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    await Bun.sleep(20);
    expect(samplingCalls).toBe(0);

    const generated = await client.callTool({
      arguments: {
        allowedCorpusArtifactIds: ["artifact-1"],
        evidence: [
          {
            artifactId: "artifact-1",
            entityId: "entity-1",
            path: "sample.ts",
            range: {
              end: { column: 9, line: 0 },
              endByte: 9,
              start: { column: 0, line: 0 },
              startByte: 0,
            },
            text: "Supported",
          },
        ],
        prompt: "Answer from evidence",
        workspaceId,
      },
      name: "generate",
    });
    expect(generated.isError).not.toBeTrue();
    expect(generated.structuredContent).toMatchObject({
      data: {
        generated: { answer: "Supported." },
        provider: "mcp",
        status: "succeeded",
      },
      ok: true,
    });
    expect(samplingCalls).toBe(1);
  } finally {
    await client.close();
    await rm(root, { force: true, recursive: true });
  }
});

test("stdio rejects outside paths for native code tools", async () => {
  const client = new Client({ name: "root-boundary-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: [path.resolve(import.meta.dir, "../src/index.ts")],
    command: "bun",
    cwd: path.resolve(import.meta.dir, ".."),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    for (const name of NATIVE_CODE_TOOLS.filter((tool) => tool !== "squeeze")) {
      const result = await client.callTool({
        arguments: { paths: ["/etc/hosts"] },
        name,
      });
      expect(result.isError).toBeTrue();
    }
  } finally {
    await client.close();
  }
});
