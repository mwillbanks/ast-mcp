import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

async function git(root: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", root, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_AUTHOR_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
    },
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

function data<T>(result: { structuredContent?: unknown }): T {
  return (result.structuredContent as { data: T }).data;
}

test("MCP indexes Git revisions and retrieves graph, lexical, and semantic intelligence", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-index-lifecycle-"),
  );
  const storagePath = path.join(root, "..", `${path.basename(root)}-index`);
  await git(root, ["init", "-b", "main"]);
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    `version = 2

[intelligence.retrieval]
semantic = true

[intelligence.retrieval.embedding]
model_id = "fixture/config-model"
revision = "fixture-revision"
dimensions = 4
dtype = "fp32"
pooling = "mean"
workers = 2
batch_size = 4
max_queue = 16
`,
  );
  await writeFile(
    path.join(root, "historical.ts"),
    "export function historicalMarker() { return 'history'; }\n",
  );
  await writeFile(
    path.join(root, "consumer.ts"),
    "import { historicalMarker } from './historical';\nexport const historicalConsumer = historicalMarker();\n",
  );
  await git(root, ["add", "historical.ts", "consumer.ts", "ast-mcp.toml"]);
  await git(root, ["commit", "-m", "base"]);
  const commit = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["tag", "v1", commit]);
  await writeFile(
    path.join(root, "intent-to-add.ts"),
    "export const intentToAdd = true;\n",
  );
  await git(root, ["add", "--intent-to-add", "intent-to-add.ts"]);
  await git(root, [
    "update-index",
    "--add",
    "--cacheinfo",
    "160000",
    commit,
    "vendor-gitlink",
  ]);
  await writeFile(
    path.join(root, "historical.ts"),
    "export function workingMarker() { return 'working'; }\n",
  );
  await writeFile(
    path.join(root, "untracked.ts"),
    "export const untrackedMarker = 'untracked';\n",
  );

  const client = new Client({
    name: "index-lifecycle-test",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    args: [
      path.resolve(
        import.meta.dir,
        "fixtures/intelligence/index-lifecycle-server.ts",
      ),
    ],
    command: "bun",
    cwd: root,
    env: {
      ...process.env,
      AST_MCP_EMBEDDING_MODEL: "fixture/embedding",
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const historicalArtifacts: string[] = [];
    for (const revision of [
      { kind: "commit" as const, oid: commit },
      { kind: "index" as const },
      { kind: "branch" as const, name: "main" },
      { kind: "tag" as const, name: "v1" },
    ]) {
      const opened = await client.callTool({
        arguments: {
          directory: root,
          revision,
          storage: { kind: "explicit", path: storagePath },
        },
        name: "workspace_open",
      });
      expect(opened.isError).not.toBeTrue();
      const workspace = data<{
        workspace: {
          selectedRevision: { revisionId: string };
          workspaceId: string;
        };
      }>(opened).workspace;
      const indexed = await client.callTool({
        arguments: { action: "build", workspaceId: workspace.workspaceId },
        name: "index",
      });
      if (indexed.isError) throw new Error(JSON.stringify(indexed));
      expect(indexed.isError).not.toBeTrue();
      const indexedData = data<{
        generation: string;
        result: { skippedFiles: string[] };
        revision: string;
      }>(indexed);
      expect(indexedData).toMatchObject({
        revision: workspace.selectedRevision.revisionId,
      });
      if (revision.kind === "index") {
        expect(indexedData.result.skippedFiles).toContain(
          "intent-to-add.ts [index:intent-to-add]",
        );
        expect(indexedData.result.skippedFiles).toContain(
          "vendor-gitlink [index:non-blob-160000]",
        );
      }

      const lexical = await client.callTool({
        arguments: {
          query: "historicalMarker",
          semantic: false,
          workspaceId: workspace.workspaceId,
        },
        name: "retrieve",
      });
      if (lexical.isError) throw new Error(JSON.stringify(lexical));
      expect(lexical.isError).not.toBeTrue();
      const lexicalData = data<{
        generation: string;
        results: Array<{
          artifactId: string;
          entityId: string;
          text: string;
        }>;
        scope: {
          generationId: string;
          revisionId: string;
          workspaceId: string;
        };
      }>(lexical);
      expect(lexicalData.scope.workspaceId).toBe(workspace.workspaceId);
      expect(lexicalData.scope.revisionId).toBe(
        workspace.selectedRevision.revisionId,
      );
      expect(lexicalData.results[0]?.text).toContain("historicalMarker");
      expect(JSON.stringify(lexicalData)).not.toContain("workingMarker");
      expect(JSON.stringify(lexicalData)).not.toContain("untrackedMarker");
      historicalArtifacts.push(lexicalData.results[0]?.artifactId ?? "");

      const graph = await client.callTool({
        arguments: {
          operation: "traverse",
          startNodeIds: [lexicalData.results[0]?.entityId],
          workspaceId: workspace.workspaceId,
        },
        name: "graph_query",
      });
      expect(graph.isError).not.toBeTrue();
      expect(
        data<{ generation: string; revision: string }>(graph),
      ).toMatchObject({
        generation: lexicalData.scope.generationId,
        revision: workspace.selectedRevision.revisionId,
      });

      const semantic = await client.callTool({
        arguments: {
          query: "historical behavior",
          semantic: true,
          workspaceId: workspace.workspaceId,
        },
        name: "retrieve",
      });
      expect(semantic.isError).not.toBeTrue();
      expect(JSON.stringify(data(semantic))).toContain("historicalMarker");
      expect(JSON.stringify(data(semantic))).toContain(
        '"semanticState":"ready"',
      );

      const denied = await client.callTool({
        arguments: {
          files: {
            [path.join(root, "denied.ts")]: {
              content: "export const denied = true;\n",
            },
          },
          workspaceId: workspace.workspaceId,
        },
        name: "file_write",
      });
      expect(denied.isError).toBeTrue();
      expect(JSON.stringify(denied.structuredContent)).toContain(
        "workspace_read_only",
      );
    }
    expect(new Set(historicalArtifacts).size).toBe(1);

    const openedWorking = await client.callTool({
      arguments: {
        directory: root,
        revision: { kind: "working" },
        storage: { kind: "explicit", path: storagePath },
      },
      name: "workspace_open",
    });
    const working = data<{
      workspace: {
        dirtyOverlayId: string;
        selectedRevision: { revisionId: string };
        workspaceId: string;
      };
    }>(openedWorking).workspace;
    expect(working.dirtyOverlayId).toStartWith("dirty-overlay:v1:");
    const indexedWorking = await client.callTool({
      arguments: { action: "refresh", workspaceId: working.workspaceId },
      name: "index",
    });
    expect(indexedWorking.isError).not.toBeTrue();

    const semanticWorking = await client.callTool({
      arguments: {
        query: "working behavior",
        semantic: true,
        workspaceId: working.workspaceId,
      },
      name: "retrieve",
    });
    expect(semanticWorking.isError).not.toBeTrue();
    expect(JSON.stringify(data(semanticWorking))).toContain("workingMarker");
    expect(JSON.stringify(data(semanticWorking))).not.toContain(
      "historicalMarker",
    );
  } finally {
    await client.close();
    await rm(root, { force: true, recursive: true });
    await rm(storagePath, { force: true, recursive: true });
  }
}, 120_000);

test("MCP publishes lexical and graph intelligence when embeddings fail", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ast-mcp-index-degraded-"));
  const storagePath = path.join(root, "..", `${path.basename(root)}-index`);
  await git(root, ["init", "-b", "main"]);
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    `version = 2

[intelligence.retrieval]
semantic = true

[intelligence.retrieval.embedding]
model_id = "fixture/config-model"
revision = "fixture-revision"
dimensions = 4
dtype = "fp32"
pooling = "mean"
workers = 1
batch_size = 2
max_queue = 8
`,
  );
  await writeFile(
    path.join(root, "degraded.ts"),
    "export function degradedMarker() { return 'lexical survives'; }\n",
  );
  await git(root, ["add", "ast-mcp.toml", "degraded.ts"]);
  await git(root, ["commit", "-m", "degraded"]);
  const commit = await git(root, ["rev-parse", "HEAD"]);
  const client = new Client({ name: "degraded-index-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: [
      path.resolve(
        import.meta.dir,
        "fixtures/intelligence/index-lifecycle-server.ts",
      ),
    ],
    command: "bun",
    cwd: root,
    env: {
      ...process.env,
      AST_MCP_EMBEDDING_MODEL: "fixture/embedding",
      AST_MCP_FAIL_EMBEDDINGS: "1",
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const opened = await client.callTool({
      arguments: {
        directory: root,
        revision: { kind: "commit", oid: commit },
        storage: { kind: "explicit", path: storagePath },
      },
      name: "workspace_open",
    });
    const workspace = data<{ workspace: { workspaceId: string } }>(
      opened,
    ).workspace;
    const indexed = await client.callTool({
      arguments: { action: "build", workspaceId: workspace.workspaceId },
      name: "index",
    });
    if (indexed.isError) throw new Error(JSON.stringify(indexed));
    const retrieved = await client.callTool({
      arguments: {
        query: "degradedMarker",
        semantic: true,
        workspaceId: workspace.workspaceId,
      },
      name: "retrieve",
    });
    if (retrieved.isError) throw new Error(JSON.stringify(retrieved));
    const result = data<{
      coverage: { degraded: boolean; semanticState: string };
      freshness: { reason: string | null; stale: boolean };
      results: Array<{ text: string }>;
    }>(retrieved);
    expect(result.results[0]?.text).toContain("degradedMarker");
    expect(result.coverage).toMatchObject({
      degraded: true,
      semanticState: "unavailable",
    });
    expect(result.freshness).toMatchObject({
      reason: "embedding jobs failed",
      stale: true,
    });
  } finally {
    await client.close();
    await rm(root, { force: true, recursive: true });
    await rm(storagePath, { force: true, recursive: true });
  }
}, 120_000);

test("MCP indexes every native language group and project formats", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ast-mcp-index-languages-"),
  );
  const storagePath = path.join(root, "..", `${path.basename(root)}-index`);
  await git(root, ["init", "-b", "main"]);
  const sources = new Map<string, string>([
    ["dynamic.py", "def dynamic_marker():\n    return 'dynamic-marker'\n"],
    ["infra.tf", 'resource "null_resource" "infra_marker" {}\n'],
    ["JvmMarker.java", "class JvmMarker { void jvmMarker() {} }\n"],
    [
      "legacy.pas",
      "program LegacyMarker; begin writeln('legacy-marker'); end.\n",
    ],
    ["systems.rs", 'fn systems_marker() { println!("systems-marker"); }\n'],
    [
      "component.vue",
      "<script>export function webMarker(){ return 'web-marker' }</script>\n",
    ],
    [
      "app.csproj",
      '<Project><ItemGroup><ProjectReference Include="ProjectMarker.csproj" /></ItemGroup></Project>\n',
    ],
    ["guide.md", "# DocumentMarker\n\ndocument-marker evidence\n"],
  ]);
  await writeFile(
    path.join(root, "ast-mcp.toml"),
    "version = 2\n\n[intelligence.retrieval]\nsemantic = false\n",
  );
  for (const [file, content] of sources)
    await writeFile(path.join(root, file), content);
  await git(root, ["add", "ast-mcp.toml", ...sources.keys()]);
  await git(root, ["commit", "-m", "languages"]);
  const commit = await git(root, ["rev-parse", "HEAD"]);
  const client = new Client({ name: "language-index-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    args: [
      path.resolve(
        import.meta.dir,
        "fixtures/intelligence/index-lifecycle-server.ts",
      ),
    ],
    command: "bun",
    cwd: root,
    env: process.env as Record<string, string>,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const opened = await client.callTool({
      arguments: {
        directory: root,
        revision: { kind: "commit", oid: commit },
        storage: { kind: "explicit", path: storagePath },
      },
      name: "workspace_open",
    });
    const workspace = data<{ workspace: { workspaceId: string } }>(
      opened,
    ).workspace;
    const indexed = await client.callTool({
      arguments: { action: "build", workspaceId: workspace.workspaceId },
      name: "index",
    });
    if (indexed.isError) throw new Error(JSON.stringify(indexed));
    const parsedFiles = data<{ result: { parsedFiles: string[] } }>(indexed)
      .result.parsedFiles;
    for (const file of sources.keys()) expect(parsedFiles).toContain(file);

    const queries = new Map<string, string>([
      ["dynamic_marker", "dynamic.py"],
      ["infra_marker", "infra.tf"],
      ["JvmMarker", "JvmMarker.java"],
      ["LegacyMarker", "legacy.pas"],
      ["systems_marker", "systems.rs"],
      ["webMarker", "component.vue"],
      ["ProjectMarker", "app.csproj"],
      ["DocumentMarker", "guide.md"],
    ]);
    for (const [query, expectedPath] of queries) {
      const retrieved = await client.callTool({
        arguments: {
          query,
          semantic: false,
          workspaceId: workspace.workspaceId,
        },
        name: "retrieve",
      });
      if (retrieved.isError) throw new Error(JSON.stringify(retrieved));
      const results = data<{ results: Array<{ path: string }> }>(
        retrieved,
      ).results;
      expect(results.some((item) => item.path === expectedPath)).toBeTrue();
    }
  } finally {
    await client.close();
    await rm(root, { force: true, recursive: true });
    await rm(storagePath, { force: true, recursive: true });
  }
}, 120_000);
